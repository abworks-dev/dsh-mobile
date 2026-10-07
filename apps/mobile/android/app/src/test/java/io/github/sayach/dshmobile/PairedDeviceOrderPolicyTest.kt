package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Locks the fixed paired-device order and the two arrangement actions.
 *
 * The fixed order is the compatibility gate: an upgrade must not reshuffle a list the user has
 * already arranged, and connecting to a computer must stop moving its row to the front.
 */
class PairedDeviceOrderPolicyTest {
    private val tencent = device("a", "腾讯云4-4", lastConnectedAt = 1_000)
    private val hk = device("b", "HK8-8", lastConnectedAt = 9_000)
    private val laptop = device("c", "Laptop", lastConnectedAt = null)
    private val rows = listOf(tencent, hk, laptop)

    @Test
    fun theDisplayOrderIsTheStoredOrderEvenWhenAnotherRowConnectedMoreRecently() {
        // The old last-used sort would have returned HK8-8 first.
        assertEquals(listOf("腾讯云4-4", "HK8-8", "Laptop"), names(PairedDeviceOrderPolicy.displayOrder(rows)))
        assertSame(rows, PairedDeviceOrderPolicy.displayOrder(rows))
    }

    @Test
    fun anUpgradeKeepsTheOrderTheUserAlreadyHas() {
        val current = listOf(hk, tencent, laptop)

        assertEquals(listOf("HK8-8", "腾讯云4-4", "Laptop"), names(PairedDeviceOrderPolicy.displayOrder(current)))
    }

    @Test
    fun moveUpTradesWithTheRowAboveAndKeepsEveryOtherRowInPlace() {
        assertEquals(listOf("HK8-8", "腾讯云4-4", "Laptop"), names(PairedDeviceOrderPolicy.moveUp(rows, hk.key)))
        assertEquals(listOf("腾讯云4-4", "Laptop", "HK8-8"), names(PairedDeviceOrderPolicy.moveUp(rows, laptop.key)))
    }

    @Test
    fun moveToTopMovesOneRowAheadOfEveryOtherRow() {
        assertEquals(listOf("Laptop", "腾讯云4-4", "HK8-8"), names(PairedDeviceOrderPolicy.moveToTop(rows, laptop.key)))
        assertEquals(listOf("HK8-8", "腾讯云4-4", "Laptop"), names(PairedDeviceOrderPolicy.moveToTop(rows, hk.key)))
    }

    @Test
    fun theFirstRowAndUnknownKeysKeepTheOrderTheyWereGiven() {
        val empty = emptyList<PairedDeviceRecord>()

        assertSame(rows, PairedDeviceOrderPolicy.moveUp(rows, tencent.key))
        assertSame(rows, PairedDeviceOrderPolicy.moveToTop(rows, tencent.key))
        assertSame(rows, PairedDeviceOrderPolicy.moveUp(rows, "lan:" + "f".repeat(64)))
        assertSame(rows, PairedDeviceOrderPolicy.moveToTop(rows, "lan:" + "f".repeat(64)))
        assertSame(empty, PairedDeviceOrderPolicy.moveUp(empty, tencent.key))
        assertSame(empty, PairedDeviceOrderPolicy.moveToTop(empty, tencent.key))
    }

    @Test
    fun theTwoArrangementActionsOnlyAppearWhereTheyChangeSomething() {
        assertFalse(PairedDeviceOrderPolicy.canMoveUp(rows, tencent.key))
        assertFalse(PairedDeviceOrderPolicy.canMoveToTop(rows, tencent.key))
        assertTrue(PairedDeviceOrderPolicy.canMoveUp(rows, hk.key))
        assertFalse(PairedDeviceOrderPolicy.canMoveToTop(rows, hk.key))
        assertTrue(PairedDeviceOrderPolicy.canMoveUp(rows, laptop.key))
        assertTrue(PairedDeviceOrderPolicy.canMoveToTop(rows, laptop.key))
        assertFalse(PairedDeviceOrderPolicy.canMoveUp(rows, "lan:" + "f".repeat(64)))
        assertFalse(PairedDeviceOrderPolicy.canMoveToTop(rows, "lan:" + "f".repeat(64)))
    }

    @Test
    fun aMovedRowKeepsItsRecordAndEveryRemainingRowKeepsItsRelativeOrder() {
        val moved = PairedDeviceOrderPolicy.moveUp(rows, laptop.key)

        assertSame(laptop, moved[1])
        assertEquals(listOf(tencent.key, hk.key), listOf(moved[0].key, moved[2].key))
    }

    private fun names(rows: List<PairedDeviceRecord>): List<String> = rows.map { it.displayName }

    private fun device(instanceCharacter: String, name: String, lastConnectedAt: Long?) = PairedDeviceRecord(
        instanceId = instanceCharacter.repeat(64),
        deviceId = "c".repeat(32),
        displayName = name,
        mode = AccessMode.LAN,
        origin = GatewayOrigin.parse("https://192.168.1.20:3443")!!,
        deviceToken = "A".repeat(43),
        expiresAt = 2_000_000_000_000,
        caCertificate = null,
        lastConnectedAt = lastConnectedAt,
        lastReachableAt = null,
        status = PairedDeviceStatus.UNKNOWN,
    )
}
