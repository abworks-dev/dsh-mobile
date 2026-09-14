package io.github.sayach.dshmobile

import android.content.Context
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

/** A device row state shown by the connection center. */
internal enum class PairedDeviceStatus {
    UNKNOWN,
    REACHABLE,
    UNREACHABLE,
    REVOKED,
    EXPIRED,
    ADDRESS_CHANGED,
}

/** One locally paired DSH installation; tokens and LAN CA bytes stay encrypted at rest. */
internal data class PairedDeviceRecord(
    val instanceId: String,
    val deviceId: String,
    val displayName: String,
    val mode: AccessMode,
    val origin: GatewayOrigin,
    val deviceToken: String,
    val expiresAt: Long,
    val caCertificate: ByteArray?,
    val lastConnectedAt: Long?,
    val lastReachableAt: Long?,
    val status: PairedDeviceStatus,
) {
    /** Stable local key used to merge a rotated cpolar origin or a re-pair. */
    val key: String get() = "${mode.name.lowercase()}:$instanceId"

}

/** Encrypted multi-device store with one-time migration support for the two legacy slots. */
internal class PairedDeviceStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    /** Return all valid rows in stable last-used order. */
    fun load(): List<PairedDeviceRecord> = decode(preferences.getString(PAYLOAD_KEY, null))
        .sortedWith(compareByDescending<PairedDeviceRecord> { it.lastConnectedAt ?: Long.MIN_VALUE }.thenBy { it.key })

    /** Whether the store has completed the legacy-slot migration marker. */
    fun isMigrationComplete(): Boolean = preferences.getBoolean(MIGRATION_KEY, false)

    /** Write legacy rows once without touching their old stores. */
    fun migrateLegacy(rows: List<PairedDeviceRecord>): List<PairedDeviceRecord> {
        if (isMigrationComplete()) return load()
        val normalized = rows.distinctBy { it.key }
        save(normalized)
        preferences.edit().putBoolean(MIGRATION_KEY, true).apply()
        return normalized
    }

    /** Insert or replace one row identified by its mode and DSH instance id. */
    fun upsert(record: PairedDeviceRecord): PairedDeviceRecord {
        val rows = load().toMutableList()
        val index = rows.indexOfFirst { it.key == record.key }
        if (index >= 0) rows[index] = record else rows += record
        save(rows)
        return record
    }

    /** Update one row while retaining its encrypted credential fields. */
    fun update(
        key: String,
        transform: (PairedDeviceRecord) -> PairedDeviceRecord,
    ): PairedDeviceRecord? {
        val rows = load().toMutableList()
        val index = rows.indexOfFirst { it.key == key }
        if (index < 0) return null
        val updated = transform(rows[index])
        rows[index] = updated
        save(rows)
        return updated
    }

    /** Remove one local row and its credential; the computer-side device is unchanged. */
    fun remove(key: String): Boolean {
        val rows = load().toMutableList()
        val removed = rows.removeIf { it.key == key }
        if (!removed) return false
        save(rows)
        return true
    }

    /** Remove every local row and the encryption key. */
    fun clear() {
        preferences.edit().clear().apply()
        runCatching {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(KEY_ALIAS)
        }
    }

    private fun save(rows: List<PairedDeviceRecord>) {
        require(rows.size <= MAX_DEVICES)
        val json = JSONArray()
        rows.forEach { row ->
            requireValid(row)
            json.put(encode(row))
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        preferences.edit()
            .putString(PAYLOAD_KEY, Base64.encodeToString(cipher.doFinal(json.toString().toByteArray()), Base64.NO_WRAP))
            .putString(IV_KEY, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    private fun decode(payload: String?): List<PairedDeviceRecord> {
        if (payload.isNullOrBlank()) return emptyList()
        val encrypted = runCatching { Base64.decode(payload, Base64.NO_WRAP) }.getOrNull() ?: return emptyList()
        val iv = runCatching { Base64.decode(preferences.getString(IV_KEY, null), Base64.NO_WRAP) }.getOrNull() ?: return emptyList()
        val text = runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, existingKey() ?: return emptyList(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(encrypted), Charsets.UTF_8)
        }.getOrNull() ?: return emptyList()
        val array = runCatching { JSONArray(text) }.getOrNull() ?: return emptyList()
        val rows = mutableListOf<PairedDeviceRecord>()
        for (index in 0 until array.length()) {
            parse(array.optJSONObject(index))?.let { rows += it }
        }
        return rows.distinctBy { it.key }.take(MAX_DEVICES)
    }

    private fun parse(value: JSONObject?): PairedDeviceRecord? {
        if (value == null || value.optInt("version", -1) != 1) return null
        val instanceId = value.optString("instanceId")
        val deviceId = value.optString("deviceId")
        val token = value.optString("deviceToken")
        val mode = AccessMode.parse(value.optString("mode")) ?: return null
        val origin = GatewayOrigin.parse(value.optString("origin")) ?: return null
        val name = normalizeDisplayName(value.optString("displayName")) ?: return null
        val expiresAt = value.optLong("expiresAt", -1L)
        val ca = value.optString("caCertificate", PUBLIC_TLS).takeUnless { it == PUBLIC_TLS }?.let {
            runCatching { Base64.decode(it, Base64.NO_WRAP) }.getOrNull()
        }
        val status = runCatching { PairedDeviceStatus.valueOf(value.optString("status")) }.getOrNull() ?: PairedDeviceStatus.UNKNOWN
        val row = PairedDeviceRecord(
            instanceId = instanceId,
            deviceId = deviceId,
            displayName = name,
            mode = mode,
            origin = origin,
            deviceToken = token,
            expiresAt = expiresAt,
            caCertificate = ca,
            lastConnectedAt = optionalLong(value, "lastConnectedAt"),
            lastReachableAt = optionalLong(value, "lastReachableAt"),
            status = status,
        )
        return row.takeIf { isValid(it) }
    }

    private fun encode(row: PairedDeviceRecord): JSONObject = JSONObject().apply {
        put("version", 1)
        put("instanceId", row.instanceId)
        put("deviceId", row.deviceId)
        put("displayName", row.displayName)
        put("mode", row.mode.name)
        put("origin", row.origin.serialized)
        put("deviceToken", row.deviceToken)
        put("expiresAt", row.expiresAt)
        put("caCertificate", row.caCertificate?.let { Base64.encodeToString(it, Base64.NO_WRAP) } ?: PUBLIC_TLS)
        if (row.lastConnectedAt != null) put("lastConnectedAt", row.lastConnectedAt)
        if (row.lastReachableAt != null) put("lastReachableAt", row.lastReachableAt)
        put("status", row.status.name)
    }

    private fun requireValid(row: PairedDeviceRecord) {
        require(isValid(row)) { "invalid paired device record" }
    }

    private fun isValid(row: PairedDeviceRecord): Boolean =
        INSTANCE_ID.matches(row.instanceId)
            && (row.deviceId.isEmpty() || DEVICE_ID.matches(row.deviceId))
            && TOKEN.matches(row.deviceToken)
            && RemoteHostPolicy.isAllowed(row.mode, row.origin.host)
            && row.expiresAt > 0L
            && when (row.mode) {
                AccessMode.LAN -> row.caCertificate?.let { PairingTrust.validateCertificate(it, row.instanceId) != null } == true
                AccessMode.REMOTE -> row.caCertificate == null
            }
            && normalizeDisplayName(row.displayName) != null

    private fun normalizeDisplayName(value: String): String? {
        val normalized = java.text.Normalizer.normalize(value, java.text.Normalizer.Form.NFC).trim()
        if (normalized.length > MAX_NAME_CHARS || CONTROL_CHARS.containsMatchIn(normalized)) return null
        return normalized.takeIf { it.isNotEmpty() }
    }

    private fun optionalLong(value: JSONObject, key: String): Long? =
        if (!value.has(key) || value.isNull(key)) null else value.optLong(key, Long.MIN_VALUE).takeIf { it > 0L }

    private fun key(): SecretKey {
        existingKey()?.let { return it }
        return KeyGenerator.getInstance("AES", "AndroidKeyStore").run {
            init(android.security.keystore.KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT,
            ).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
                .build())
            generateKey()
        }
    }

    private fun existingKey(): SecretKey? = runCatching {
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(KEY_ALIAS, null) as? SecretKey
    }.getOrNull()

    private companion object {
        const val PREFERENCES_NAME = "dsh_mobile_devices_v1"
        const val PAYLOAD_KEY = "payload"
        const val IV_KEY = "iv"
        const val MIGRATION_KEY = "legacy_migrated"
        const val KEY_ALIAS = "dsh_mobile_devices_v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val PUBLIC_TLS = "-"
        const val MAX_DEVICES = 64
        const val MAX_NAME_CHARS = 32
        val CONTROL_CHARS = Regex("[\\u0000-\\u001f\\u007f]")
        val INSTANCE_ID = Regex("^[a-f0-9]{64}$")
        val DEVICE_ID = Regex("^[a-f0-9]{32}$")
        val TOKEN = Regex("^[A-Za-z0-9_-]{43}$")
    }
}
