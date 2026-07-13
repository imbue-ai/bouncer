#!/usr/bin/env python3
"""Convert a detector head (head.tflite) to the blob that the iOS
app's `DetectorHead` (Accelerate) reads.

Two known head architectures, auto-detected from the graph:
  DH01 (E4B): LayerNorm -> Linear(H->H) -> GELU -> Linear(H->4)   (MLP head)
  DH02 (E2B): LayerNorm -> Linear(H->4, optional bias)            (linear probe)

The script extracts the weight tensors, reads the exact GELU variant +
LayerNorm epsilon from the graph (so the Swift reimpl can be verified to
match), and packs the blob.

Usage:
    python3 scripts/convert_detector_head.py \
        --tflite /tmp/detector/head.tflite \
        --out "Bouncer_xcode/iOS (App)/detector_head_v1.bin"

No TFLite *interpreter* is required (parses the flatbuffer via the `tflite`
schema pkg). For a full numerical check, run the packed blob against the
interpreter in an env with ai_edge_litert.
"""
import argparse, struct, sys
import numpy as np
import tflite


# Minimal TFLite BuiltinOperator codes we expect in these graphs.
FULLY_CONNECTED, GELU, MUL, ADD, RSQRT = 9, 150, 18, 0, 76


def load(path):
    buf = open(path, "rb").read()
    return tflite.Model.GetRootAsModel(buf, 0), buf


def tensor_np(model, sg, idx):
    t = sg.Tensors(idx)
    shape = [t.Shape(j) for j in range(t.ShapeLength())]
    raw = model.Buffers(t.Buffer()).DataAsNumpy()
    if isinstance(raw, int):  # empty buffer
        raise ValueError(f"tensor {idx} has no constant buffer")
    arr = np.frombuffer(raw.tobytes(), dtype=np.float32)
    return arr.reshape(shape) if shape else arr


def extract_layernorm(model, sg, opcodes, hidden, exclude_ids):
    """Finds LN gamma/beta (the two [hidden] f32 constants, disambiguated by
    MUL vs ADD consumption) and eps (the scalar added before RSQRT)."""
    vecs, scalars = [], []
    for i in range(sg.TensorsLength()):
        t = sg.Tensors(i)
        if t.Type() != 0:  # F32 only
            continue
        try:
            arr = tensor_np(model, sg, i)
        except ValueError:
            continue
        if arr.size == hidden and i not in exclude_ids:
            vecs.append((i, arr.reshape(-1)))
        elif arr.size == 1:
            scalars.append((i, float(arr.reshape(-1)[0])))

    mul_vec = add_vec = None
    vec_ids = {i for i, _ in vecs}
    for i in range(sg.OperatorsLength()):
        op = sg.Operators(i); bc = opcodes[op.OpcodeIndex()]
        ins = [op.Inputs(j) for j in range(op.InputsLength())]
        for vid in vec_ids:
            if vid in ins:
                if bc == MUL: mul_vec = vid
                elif bc == ADD: add_vec = vid
    gamma = dict(vecs)[mul_vec] if mul_vec is not None else vecs[0][1]
    beta = dict(vecs)[add_vec] if add_vec is not None else vecs[1][1]

    eps = None
    rsqrt_inputs = {sg.Operators(i).Inputs(0)
                    for i in range(sg.OperatorsLength())
                    if opcodes[sg.Operators(i).OpcodeIndex()] == RSQRT}
    for i in range(sg.OperatorsLength()):
        op = sg.Operators(i)
        if opcodes[op.OpcodeIndex()] == ADD and op.Outputs(0) in rsqrt_inputs:
            for j in range(op.InputsLength()):
                for si, sv in scalars:
                    if si == op.Inputs(j):
                        eps = sv
    if eps is None:  # fallback: smallest scalar looks like an eps
        eps = min((v for _, v in scalars if 0 < v < 1e-2), default=1e-5)
    return gamma, beta, eps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tflite", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    model, _ = load(args.tflite)
    sg = model.Subgraphs(0)
    opcodes = [model.OperatorCodes(i).BuiltinCode()
               for i in range(model.OperatorCodesLength())]

    fc_ops, gelu_op = [], None
    for i in range(sg.OperatorsLength()):
        op = sg.Operators(i)
        bc = opcodes[op.OpcodeIndex()]
        if bc == FULLY_CONNECTED:
            fc_ops.append(op)
        elif bc == GELU:
            gelu_op = op

    def fc_weights(op):
        w = tensor_np(model, sg, op.Inputs(1))
        bias_idx = op.Inputs(2) if op.InputsLength() > 2 else -1
        b = (tensor_np(model, sg, bias_idx) if bias_idx >= 0
             else np.zeros(w.shape[0], np.float32))
        return w, b, bias_idx

    def f32(a): return np.asarray(a, dtype="<f4").tobytes()

    if len(fc_ops) == 2 and gelu_op is not None:
        # --- DH01: LayerNorm -> Linear(H->H) -> GELU -> Linear(H->4) ---
        fc1, fc2 = fc_ops
        w1, b1, _ = fc_weights(fc1)
        w2, b2, _ = fc_weights(fc2)
        hidden, nclass = w1.shape[1], w2.shape[0]
        assert w1.shape == (hidden, hidden), w1.shape
        assert w2.shape == (nclass, hidden), w2.shape

        from tflite.GeluOptions import GeluOptions
        go = GeluOptions()
        go.Init(gelu_op.BuiltinOptions().Bytes, gelu_op.BuiltinOptions().Pos)
        gelu_approx = bool(go.Approximate())

        exclude = {fc1.Inputs(1), fc1.Inputs(2), fc2.Inputs(1), fc2.Inputs(2)}
        gamma, beta, eps = extract_layernorm(model, sg, opcodes, hidden, exclude)

        print("=== DH01 (MLP head) ===")
        print(f"  hidden={hidden}  n_class={nclass}")
        print(f"  w1 {w1.shape}  b1 {b1.shape}   w2 {w2.shape}  b2 {b2.shape}")
        print(f"  LayerNorm eps = {eps!r}")
        print(f"  GELU approximate = {gelu_approx}  ({'tanh' if gelu_approx else 'erf (exact)'})")
        if gelu_approx:
            print("*** NOTE: GELU is tanh-approx — DetectorHead uses erf; switch it.")

        blob = b"DH01" + struct.pack("<II", hidden, nclass)
        blob += f32(gamma) + f32(beta) + f32(w1) + f32(b1) + f32(w2) + f32(b2)

    elif len(fc_ops) == 1 and gelu_op is None:
        # --- DH02: LayerNorm -> Linear(H->4), bias optional ---
        (fc,) = fc_ops
        w, b, bias_idx = fc_weights(fc)
        nclass, hidden = w.shape

        exclude = {fc.Inputs(1)} | ({bias_idx} if bias_idx >= 0 else set())
        gamma, beta, eps = extract_layernorm(model, sg, opcodes, hidden, exclude)

        print("=== DH02 (linear-probe head) ===")
        print(f"  hidden={hidden}  n_class={nclass}")
        print(f"  w {w.shape}  bias={'present' if bias_idx >= 0 else 'ABSENT (zeros packed)'}")
        print(f"  LayerNorm eps = {eps!r}")

        blob = b"DH02" + struct.pack("<II", hidden, nclass)
        blob += f32(gamma) + f32(beta) + f32(w) + f32(b)

    else:
        sys.exit(f"unrecognized head graph: {len(fc_ops)} FullyConnected, "
                 f"GELU={'yes' if gelu_op else 'no'}")

    with open(args.out, "wb") as f:
        f.write(blob)
    print(f"\nwrote {args.out}  ({len(blob)} bytes)")

    if abs(eps - 1e-5) > 1e-9:
        print(f"\n*** NOTE: eps={eps} ≠ DetectorHead's hardcoded 1e-5 — update it.")


if __name__ == "__main__":
    sys.exit(main())
