package expo.modules.t3agentnotifications

import android.app.NotificationManager
import android.content.Context
import android.net.Uri
import android.util.Base64
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

object SelfHostedPush {
  private const val STORE = "t3-self-hosted-push"
  private const val DISTRIBUTOR = "io.heckel.ntfy"
  private val alertFields = setOf(
    "device_id", "user_id", "environment_id", "registration_id", "updated_at",
    "alert_id", "alert_title", "alert_body", "alert_group", "alert_path"
  )

  private fun prefs(context: Context) = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

  private fun registrations(context: Context): JSONObject = try {
    JSONObject(prefs(context).getString("registrations", "{}") ?: "{}")
  } catch (_: JSONException) {
    JSONObject()
  }

  private fun save(context: Context, entries: JSONObject) {
    val selected = entries.keys().asSequence().any { entries.getJSONObject(it).optBoolean("enabled") }
    check(prefs(context).edit().putString("registrations", entries.toString())
      .putBoolean("selected", selected).commit()) { "SelfHostedPushStorageUnavailable" }
  }

  private fun installationId(context: Context): String {
    prefs(context).getString("installationId", null)?.let { return it }
    val id = UUID.randomUUID().toString()
    check(prefs(context).edit().putString("installationId", id).commit()) {
      "SelfHostedPushStorageUnavailable"
    }
    return id
  }

  fun isSelected(context: Context): Boolean = prefs(context).getBoolean("selected", false)

  private fun origin(value: String): String {
    val uri = try { URI(value) } catch (_: Exception) {
      throw IllegalArgumentException("SelfHostedPushInvalidOrigin")
    }
    require(uri.scheme?.lowercase(Locale.ROOT) == "https" && !uri.host.isNullOrBlank() &&
      uri.userInfo == null && uri.fragment == null && uri.query == null &&
      (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") &&
      (uri.port == -1 || uri.port in 1..65535)) { "SelfHostedPushInvalidOrigin" }
    return URI("https", null, uri.host.lowercase(Locale.ROOT),
      if (uri.port == 443) -1 else uri.port, null, null, null).toString()
  }

  private fun endpointMatches(value: String, expectedOrigin: String): Boolean = try {
    val uri = URI(value)
    uri.userInfo == null && uri.fragment == null &&
      uri.rawQuery == "up=1" &&
      Regex("/up[A-Za-z0-9]{12}").matches(uri.rawPath ?: "") &&
      origin(URI(uri.scheme, null, uri.host, uri.port, null, null, null).toString()) == expectedOrigin
  } catch (_: Exception) { false }

  internal fun registrationId(endpoint: String, p256dh: String, auth: String): String =
    MessageDigest.getInstance("SHA-256").digest("$endpoint\n$p256dh\n$auth".toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }

  @Synchronized
  fun configure(context: Context, environmentId: String, ntfyOrigin: String, scheme: String) {
    require(DISTRIBUTOR in UnifiedPush.getDistributors(context)) { "SelfHostedPushDistributorUnavailable" }
    require(UnifiedPush.getSavedDistributor(context).let { it == null || it == DISTRIBUTOR }) {
      "SelfHostedPushUnsupportedDistributor"
    }
    val instance = prepare(context, environmentId, ntfyOrigin, scheme)
    UnifiedPush.saveDistributor(context, DISTRIBUTOR)
    UnifiedPush.register(context, instance)
  }

  @Synchronized
  internal fun prepare(context: Context, environmentId: String, ntfyOrigin: String, scheme: String): String {
    require(environmentId.isNotBlank() && environmentId.length <= 256 &&
      environmentId.none { it.isISOControl() }) { "SelfHostedPushInvalidEnvironment" }
    require(Regex("[a-z][a-z0-9+.-]{0,31}").matches(scheme)) { "SelfHostedPushInvalidScheme" }
    val canonicalOrigin = origin(ntfyOrigin)
    val entries = registrations(context)
    require(entries.keys().asSequence().all {
      entries.getJSONObject(it).getString("ntfyOrigin") == canonicalOrigin
    }) { "SelfHostedPushOriginMismatch" }
    require(entries.has(environmentId) || entries.length() < 32) { "SelfHostedPushRegistrationLimit" }
    val entry = entries.optJSONObject(environmentId) ?: JSONObject()
      .put("instance", UUID.randomUUID().toString()).put("lastReceivedAt", 0)
    entry.put("ntfyOrigin", canonicalOrigin).put("scheme", scheme).put("enabled", true)
      .put("state", if (entry.has("active") && !entry.has("candidate")) "verified" else "registering")
      .remove("error")
    entries.put(environmentId, entry)
    save(context, entries)
    AgentNotifications.configure(context, installationId(context), "self-hosted", scheme, false, true)
    return entry.getString("instance")
  }

  @Synchronized
  fun disable(context: Context, environmentId: String) {
    val entries = registrations(context)
    val entry = entries.optJSONObject(environmentId) ?: return
    val previouslySelected = isSelected(context)
    entry.put("enabled", false).put("state", "disabled")
    save(context, entries)
    cancelEnvironment(context, environmentId)
    if (previouslySelected && !isSelected(context)) AgentNotifications.clear(context)
  }

  @Synchronized
  fun remove(context: Context, environmentId: String) {
    val entries = registrations(context)
    val entry = entries.optJSONObject(environmentId) ?: return
    val previouslySelected = isSelected(context)
    entries.remove(environmentId)
    save(context, entries)
    cancelEnvironment(context, environmentId)
    if (previouslySelected && !isSelected(context)) AgentNotifications.clear(context)
    UnifiedPush.unregister(context, entry.getString("instance"))
  }

  private fun cancelEnvironment(context: Context, environmentId: String) {
    val manager = context.getSystemService(NotificationManager::class.java)
    val prefix = "${Uri.encode(environmentId)}:"
    manager.activeNotifications.filter { it.notification.group?.startsWith(prefix) == true }
      .forEach { manager.cancel(it.tag, it.id) }
  }

  private fun find(entries: JSONObject, instance: String): Pair<String, JSONObject>? =
    entries.keys().asSequence().firstNotNullOfOrNull { id ->
      entries.optJSONObject(id)?.takeIf { it.optString("instance") == instance }?.let { id to it }
    }

  @Synchronized
  fun onNewEndpoint(context: Context, endpoint: PushEndpoint, instance: String) {
    val entries = registrations(context)
    val (_, entry) = find(entries, instance) ?: return
    if (!entry.optBoolean("enabled")) return
    val keys = endpoint.pubKeySet
    val validKeys = try {
      keys != null && Base64.decode(keys.pubKey, Base64.URL_SAFE).let { it.size == 65 && it[0] == 4.toByte() } &&
        Base64.decode(keys.auth, Base64.URL_SAFE).size == 16
    } catch (_: IllegalArgumentException) { false }
    if (endpoint.temporary || !endpointMatches(endpoint.url, entry.getString("ntfyOrigin")) || !validKeys) {
      entry.put("state", "error").put("error", "SelfHostedPushInvalidEndpoint")
    } else {
      val registration = JSONObject().put("endpoint", endpoint.url)
        .put("p256dh", keys!!.pubKey).put("auth", keys.auth)
      val active = entry.optJSONObject("active")
      if (active == null || listOf("endpoint", "p256dh", "auth").any {
        active.optString(it) != registration.getString(it)
      }) {
        entry.put("candidate", registration).put("state", "needsAcl").remove("error")
      }
    }
    save(context, entries)
  }

  @Synchronized
  fun onMessage(context: Context, message: PushMessage, instance: String) {
    if (!message.decrypted || message.content.size !in 1..3993 || !isSelected(context)) return
    val entries = registrations(context)
    val (environmentId, entry) = find(entries, instance) ?: return
    if (!entry.optBoolean("enabled")) return
    val data = try {
      val decoded = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(message.content))
      val json = JSONObject(decoded.toString())
      if (json.length() > 24 || json.keys().asSequence().any { json.opt(it) !is String }) return
      json.keys().asSequence().filter { it in alertFields }.associateWith { json.getString(it) }
    } catch (_: Exception) { return }
    if (data["environment_id"] != environmentId || data["device_id"] != installationId(context) ||
      data["user_id"] != "self-hosted") return
    val path = data["alert_path"] ?: return
    val prefix = "/threads/${Uri.encode(environmentId)}/"
    if (!path.startsWith(prefix) || path.removePrefix(prefix).let {
      it.isEmpty() || it.length > 768 || it.any { c -> c == '/' || c == '?' || c == '#' || c.isISOControl() }
    }) return
    val alertId = data["alert_id"]?.takeIf { it.isNotBlank() && it.length <= 512 } ?: return
    if ((data["alert_title"]?.length ?: 0) !in 1..120 || (data["alert_body"]?.length ?: 0) !in 1..608 ||
      (data["alert_group"]?.length ?: 0) > 512) return
    val candidate = entry.optJSONObject("candidate")
    val active = entry.optJSONObject("active")
    val registration = listOfNotNull(candidate, active).firstOrNull {
      registrationId(it.getString("endpoint"), it.getString("p256dh"), it.getString("auth")) == data["registration_id"]
    } ?: return
    AgentNotifications.configure(context, installationId(context), "self-hosted", entry.getString("scheme"), false, true)
    val namespace = Uri.encode(environmentId)
    val scoped = data + ("alert_id" to "$namespace:$alertId") +
      ("alert_group" to "$namespace:${data["alert_group"].orEmpty()}")
    if (!AgentNotifications.receive(context, scoped, true)) return
    if (registration === candidate) {
      entry.put("active", candidate).remove("candidate")
    }
    entry.put("lastReceivedAt", System.currentTimeMillis()).remove("error")
    entry.put("state", if (entry.has("candidate")) "needsAcl" else "verified")
    save(context, entries)
  }

  @Synchronized
  fun failed(context: Context, instance: String) {
    val entries = registrations(context)
    val (_, entry) = find(entries, instance) ?: return
    entry.put("state", "error").put("error", "SelfHostedPushRegistrationFailed")
    save(context, entries)
  }

  @Synchronized
  fun unregistered(context: Context, instance: String) {
    val entries = registrations(context)
    val (environmentId, entry) = find(entries, instance) ?: return
    val previouslySelected = isSelected(context)
    entry.put("enabled", false).put("state", "error").put("error", "SelfHostedPushDistributorUnavailable")
    save(context, entries)
    cancelEnvironment(context, environmentId)
    if (previouslySelected && !isSelected(context)) AgentNotifications.clear(context)
  }

  @Synchronized
  fun status(context: Context): String {
    val entries = registrations(context)
    val result = JSONArray()
    entries.keys().forEach { id ->
      val entry = entries.getJSONObject(id)
      result.put(JSONObject().put("environmentId", id).put("ntfyOrigin", entry.getString("ntfyOrigin"))
        .put("enabled", entry.optBoolean("enabled")).put("state", entry.getString("state"))
        .put("lastReceivedAt", entry.optLong("lastReceivedAt", 0))
        .put("error", entry.opt("error") ?: JSONObject.NULL))
    }
    return JSONObject().put("installationId", installationId(context)).put("environments", result).toString()
  }

  @Synchronized
  fun enrollment(context: Context, environmentId: String): String {
    val entry = registrations(context).optJSONObject(environmentId)
    check(entry != null && entry.optBoolean("enabled")) { "SelfHostedPushEnrollmentUnavailable" }
    val registration = entry.optJSONObject("candidate") ?: entry.optJSONObject("active")
    check(registration != null) { "SelfHostedPushEnrollmentUnavailable" }
    return JSONObject().put("endpoint", registration.getString("endpoint"))
      .put("p256dh", registration.getString("p256dh")).put("auth", registration.getString("auth"))
      .put("installationId", installationId(context)).put("environmentId", environmentId).toString()
  }
}

class SelfHostedPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) =
    SelfHostedPush.onNewEndpoint(this, endpoint, instance)

  override fun onMessage(message: PushMessage, instance: String) =
    SelfHostedPush.onMessage(this, message, instance)

  override fun onRegistrationFailed(reason: FailedReason, instance: String) =
    SelfHostedPush.failed(this, instance)

  override fun onUnregistered(instance: String) = SelfHostedPush.unregistered(this, instance)

  override fun onTempUnavailable(instance: String) = SelfHostedPush.failed(this, instance)
}
