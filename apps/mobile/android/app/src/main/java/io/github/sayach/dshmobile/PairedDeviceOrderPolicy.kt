package io.github.sayach.dshmobile

/**
 * Presentation order of the paired-device list.
 *
 * The list is fixed: rows keep the order they were paired or last arranged in, so connecting to
 * a computer no longer moves it to the top. Only the two arrangement actions change that order,
 * and the stored array is the single source of truth.
 *
 * Startup selection is deliberately independent of this order: `ConnectionRestorePolicy`
 * prefers the saved last-used key and otherwise the most recently connected valid row.
 */
internal object PairedDeviceOrderPolicy {
    /**
     * The rows in display order: the stored array already is that order.
     *
     * Rows append when they are paired and only the two arrangement actions move them, so this
     * deliberately ignores connection times — the device used last must not jump to the front.
     */
    fun displayOrder(rows: List<PairedDeviceRecord>): List<PairedDeviceRecord> = rows

    /** Whether one row can trade places with the row above it. */
    fun canMoveUp(rows: List<PairedDeviceRecord>, key: String): Boolean = indexOf(rows, key) > 0

    /** Whether one row can jump ahead of at least one other row. */
    fun canMoveToTop(rows: List<PairedDeviceRecord>, key: String): Boolean = indexOf(rows, key) > 1

    /** Move one row one position towards the front; an unknown key or the first row changes nothing. */
    fun moveUp(rows: List<PairedDeviceRecord>, key: String): List<PairedDeviceRecord> {
        val index = indexOf(rows, key)
        if (index <= 0) return rows
        return rows.toMutableList().apply { add(index - 1, removeAt(index)) }
    }

    /** Move one row to the front; an unknown key or the first row changes nothing. */
    fun moveToTop(rows: List<PairedDeviceRecord>, key: String): List<PairedDeviceRecord> {
        val index = indexOf(rows, key)
        if (index <= 0) return rows
        return rows.toMutableList().apply { add(0, removeAt(index)) }
    }

    private fun indexOf(rows: List<PairedDeviceRecord>, key: String): Int = rows.indexOfFirst { it.key == key }
}
