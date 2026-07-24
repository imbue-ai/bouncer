package com.imbue.bouncer.inference

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Golden test against the real shipped blob. Expected values were computed offline
 * with an independent float32 implementation of the DH02 forward pass
 * (LayerNorm eps 1e-5, biased variance, then Linear) over a deterministic
 * LCG-generated activation vector.
 */
class DetectorHeadTest {

    // The blob is shared with iOS; unit tests run with the module dir as CWD.
    private val blobFile = File("../../Bouncer_xcode/iOS (App)/detector_head_e2b_v2.bin")

    private fun lcgActivations(n: Int): FloatArray {
        var seed = 1L
        return FloatArray(n) {
            seed = (seed * 1103515245L + 12345L) and 0x7FFFFFFFL
            ((seed.toDouble() / 0x7FFFFFFF) * 4.0 - 2.0).toFloat()
        }
    }

    @Test
    fun parsesShippedBlobHeader() {
        assumeTrue(blobFile.exists())
        val head = DetectorHead.parse(blobFile.readBytes())
        assertEquals(1536, head.hidden)
        assertEquals(4, head.nClass)
    }

    @Test
    fun forwardMatchesGoldenValues() {
        assumeTrue(blobFile.exists())
        val head = DetectorHead.parse(blobFile.readBytes())
        val logits = head.forward(lcgActivations(head.hidden))

        val golden = floatArrayOf(0.11396449f, 0.09690955f, -0.63102508f, 0.94890076f)
        assertEquals(golden.size, logits.size)
        for (i in golden.indices) {
            assertEquals("logit[$i]", golden[i], logits[i], 1e-3f)
        }
        assertEquals(0.6191830f, DetectorHead.aiConfidence(logits), 1e-3f)
    }

    @Test
    fun aiConfidenceRangeAndExtremes() {
        // All mass on class 0 → 0; all mass on the top class → 1.
        assertEquals(0f, DetectorHead.aiConfidence(floatArrayOf(50f, 0f, 0f, 0f)), 1e-4f)
        assertEquals(1f, DetectorHead.aiConfidence(floatArrayOf(0f, 0f, 0f, 50f)), 1e-4f)
        // Uniform logits → expectation (0+1+2+3)/4 / 3 = 0.5.
        assertEquals(0.5f, DetectorHead.aiConfidence(floatArrayOf(1f, 1f, 1f, 1f)), 1e-4f)
        assertEquals(0f, DetectorHead.aiConfidence(FloatArray(0)))
    }

    @Test
    fun erfMatchesReferenceValues() {
        // Reference values from scipy.special.erf; A&S 7.1.26 is good to ~1.5e-7.
        assertEquals(0.0f, DetectorHead.erf(0f), 1e-6f)
        assertEquals(0.5204999f, DetectorHead.erf(0.5f), 1e-5f)
        assertEquals(0.8427008f, DetectorHead.erf(1.0f), 1e-5f)
        assertEquals(-0.8427008f, DetectorHead.erf(-1.0f), 1e-5f)
        assertEquals(0.9953223f, DetectorHead.erf(2.0f), 1e-5f)
    }

    @Test
    fun rejectsBadBlobs() {
        assertTrue(runCatching { DetectorHead.parse(ByteArray(4)) }.isFailure)
        val badMagic = ByteArray(64).also { "XXXX".toByteArray().copyInto(it) }
        assertTrue(runCatching { DetectorHead.parse(badMagic) }.isFailure)
        assumeTrue(blobFile.exists())
        val truncated = blobFile.readBytes().copyOf(1000)
        assertTrue(runCatching { DetectorHead.parse(truncated) }.isFailure)
        val head = DetectorHead.parse(blobFile.readBytes())
        assertFalse(runCatching { head.forward(FloatArray(7)) }.isSuccess)
    }
}
