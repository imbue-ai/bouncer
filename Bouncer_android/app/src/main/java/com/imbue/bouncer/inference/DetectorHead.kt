package com.imbue.bouncer.inference

import android.content.Context
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.exp
import kotlin.math.sqrt

/**
 * The AI-text classifier head, ported from the iOS `DetectorHead`
 * (Bouncer_xcode/iOS (App)/LocalInferenceService.swift). Runs on the [2560→hidden]
 * "activations" auxiliary output of the LoRA'd detector model and produces
 * n_class logits.
 *
 * Binary blob layout (little-endian; see scripts/convert_detector_head.py):
 *   DH01 (MLP variant):
 *     magic "DH01", hidden u32, n_class u32,
 *     ln_gamma fp32[h], ln_beta fp32[h],
 *     w1 fp32[h*h] (row-major [out,in]), b1 fp32[h],
 *     w2 fp32[n*h] (row-major [n,in]), b2 fp32[n]
 *   DH02 (linear probe):
 *     magic "DH02", hidden u32, n_class u32,
 *     ln_gamma fp32[h], ln_beta fp32[h],
 *     w2 fp32[n*h] (row-major [n,in]), b2 fp32[n] (zeros when export has no bias)
 *
 * GELU is exact/erf (`nn.GELU()` default). LayerNorm eps=1e-5 with biased
 * variance (E[x²]−E[x]²), matching the vDSP formulation on iOS.
 */
class DetectorHead private constructor(
    val hidden: Int,
    val nClass: Int,
    private val mlp: Boolean,
    private val gamma: FloatArray,
    private val beta: FloatArray,
    private val w1: FloatArray,
    private val b1: FloatArray,
    private val w2: FloatArray,
    private val b2: FloatArray,
) {

    /** DH01: LayerNorm → Linear → GELU → Linear. DH02: LayerNorm → Linear. Returns nClass logits. */
    fun forward(activations: FloatArray): FloatArray {
        require(activations.size == hidden) {
            "activation dim mismatch: got ${activations.size}, expected $hidden"
        }

        // LayerNorm over the hidden dim, biased variance via E[x²]−E[x]².
        var sum = 0.0f
        var sumSq = 0.0f
        for (x in activations) {
            sum += x
            sumSq += x * x
        }
        val mean = sum / hidden
        val meanSq = sumSq / hidden
        val invStd = 1.0f / sqrt(meanSq - mean * mean + 1e-5f)
        val xn = FloatArray(hidden)
        for (i in 0 until hidden) {
            xn[i] = (activations[i] - mean) * invStd * gamma[i] + beta[i]
        }

        // DH01 only: h = GELU(W1 @ xn + b1)
        var h = xn
        if (mlp) {
            h = FloatArray(hidden)
            for (o in 0 until hidden) {
                var acc = b1[o]
                val rowOff = o * hidden
                for (i in 0 until hidden) acc += w1[rowOff + i] * xn[i]
                h[o] = 0.5f * acc * (1.0f + erf(acc * INV_SQRT_2))
            }
        }

        // Classifier: y = W2 @ h + b2 (W2 is [n_class, hidden] row-major)
        val y = FloatArray(nClass)
        for (c in 0 until nClass) {
            var acc = b2[c]
            val rowOff = c * hidden
            for (i in 0 until hidden) acc += w2[rowOff + i] * h[i]
            y[c] = acc
        }
        return y
    }

    companion object {
        private const val INV_SQRT_2 = 0.70710678f

        fun fromAsset(context: Context, assetName: String): DetectorHead =
            parse(context.assets.open(assetName).use { it.readBytes() })

        fun parse(bytes: ByteArray): DetectorHead {
            require(bytes.size >= 12) { "detector head blob truncated (${bytes.size} bytes)" }
            val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            val magic = String(bytes, 0, 4, Charsets.US_ASCII)
            val mlp = when (magic) {
                "DH01" -> true
                "DH02" -> false
                else -> throw IllegalArgumentException("bad detector head magic: $magic")
            }
            buf.position(4)
            val hidden = buf.int
            val nClass = buf.int
            require(hidden > 0 && nClass > 0) { "bad detector head shape: hidden=$hidden nClass=$nClass" }

            val mlpFloats = if (mlp) hidden * hidden + hidden else 0
            val expected = 12L + (hidden * 2L + mlpFloats + nClass.toLong() * hidden + nClass) * 4L
            require(bytes.size >= expected) {
                "detector head blob truncated: ${bytes.size} bytes, expected $expected"
            }

            fun readFloats(count: Int): FloatArray {
                val out = FloatArray(count)
                buf.asFloatBuffer().get(out)
                buf.position(buf.position() + count * 4)
                return out
            }

            val gamma = readFloats(hidden)
            val beta = readFloats(hidden)
            val w1 = if (mlp) readFloats(hidden * hidden) else FloatArray(0)
            val b1 = if (mlp) readFloats(hidden) else FloatArray(0)
            val w2 = readFloats(nClass * hidden)
            val b2 = readFloats(nClass)
            return DetectorHead(hidden, nClass, mlp, gamma, beta, w1, b1, w2, b2)
        }

        /**
         * Normalized expected bucket index over the softmax of the classifier logits —
         * `(probs @ arange(n)) / (n - 1)`, range [0, 1] where 0 = clearly human and
         * 1 = clearly AI. Matches the detector training-pipeline scoring formula.
         */
        fun aiConfidence(logits: FloatArray): Float {
            if (logits.isEmpty()) return 0f
            val m = logits.max()
            val exps = FloatArray(logits.size) { exp(logits[it] - m) }
            val z = exps.sum()
            if (z <= 0f || logits.size < 2) return 0f
            var expectation = 0f
            for (i in exps.indices) expectation += i * (exps[i] / z)
            return expectation / (logits.size - 1)
        }

        /**
         * erf via Abramowitz & Stegun 7.1.26 (max abs error ~1.5e-7), used for the exact-GELU
         * in DH01 heads; Kotlin's stdlib has no erf.
         */
        internal fun erf(x: Float): Float {
            val t = 1.0f / (1.0f + 0.3275911f * kotlin.math.abs(x))
            val y = 1.0f - (((((1.061405429f * t - 1.453152027f) * t) + 1.421413741f) * t - 0.284496736f) * t + 0.254829592f) * t * exp(-x * x)
            return if (x >= 0f) y else -y
        }
    }
}
