package expo.modules.t3agentnotifications

import android.net.Uri
import android.app.Notification
import android.util.Base64
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.unifiedpush.android.connector.data.PublicKeySet
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], manifest = Config.NONE)
class SelfHostedPushTest : AgentNotificationsFixture() {
  private val origin = "https://ntfy.example.com"
  private val endpoint = "$origin/upExample12345?up=1"

  private fun enroll(environmentId: String = "environment"): String {
    val instance = SelfHostedPush.prepare(context, environmentId, origin, "t3code-dev")
    val publicKey = ByteArray(65).also { it[0] = 4 }
    SelfHostedPush.onNewEndpoint(
      context,
      PushEndpoint(
        endpoint,
        PublicKeySet(
          Base64.encodeToString(publicKey, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING),
          Base64.encodeToString(ByteArray(16), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        ),
        false
      ),
      instance
    )
    return instance
  }

  private fun message(environmentId: String = "environment", decrypted: Boolean = true): PushMessage {
    val enrollment = JSONObject(SelfHostedPush.enrollment(context, environmentId))
    val data = JSONObject()
      .put("device_id", enrollment.getString("installationId"))
      .put("user_id", "self-hosted")
      .put("environment_id", environmentId)
      .put("registration_id", SelfHostedPush.registrationId(endpoint, enrollment.getString("p256dh"), enrollment.getString("auth")))
      .put("updated_at", System.currentTimeMillis().toString())
      .put("alert_id", "alert-1")
      .put("alert_group", "thread")
      .put("alert_title", "Approval needed")
      .put("alert_body", "Test project")
      .put("alert_path", "/threads/${Uri.encode(environmentId)}/thread")
    return PushMessage(data.toString().toByteArray(Charsets.UTF_8), decrypted)
  }

  private fun patched(message: PushMessage, vararg fields: Pair<String, String>): PushMessage {
    val data = JSONObject(message.content.toString(Charsets.UTF_8))
    fields.forEach { (key, value) -> data.put(key, value) }
    return PushMessage(data.toString().toByteArray(Charsets.UTF_8), true)
  }

  @Test
  fun plaintextUnknownInstanceAndWrongEnvironmentAreRejected() {
    val instance = enroll()
    SelfHostedPush.onMessage(context, message(decrypted = false), instance)
    SelfHostedPush.onMessage(context, message(), "unknown-instance")
    val other = enroll("other")
    SelfHostedPush.onMessage(context, message("other"), instance)
    assertTrue(manager.activeNotifications.isEmpty())
    assertTrue(SelfHostedPush.status(context).contains("needsAcl"))
    SelfHostedPush.onMessage(context, message("other"), other)
    assertEquals(1, manager.activeNotifications.size)
  }

  @Test
  fun nativeReceiptVerifiesCandidateAndDoesNotCreateOngoingActivity() {
    val instance = enroll()
    SelfHostedPush.onMessage(context, message(), instance)
    val notification = manager.activeNotifications.single()
    assertEquals("t3-agent-alert", notification.tag)
    assertEquals("Approval needed", notification.notification.extras.getString(Notification.EXTRA_TITLE))
    assertTrue(SelfHostedPush.status(context).contains("verified"))
    SelfHostedPush.onMessage(context, message(), instance)
    assertEquals(1, manager.activeNotifications.size)
  }

  @Test
  fun cloudConfigureClearAndMessagesCannotOverrideSelfHostedOwner() {
    val instance = enroll()
    AgentNotifications.configure(context, "cloud-device", "cloud-user", "t3code-dev", true)
    AgentNotifications.clear(context)
    AgentNotifications.receive(context, update("cloud-alert", true))
    assertTrue(manager.activeNotifications.isEmpty())
    SelfHostedPush.onMessage(context, message(), instance)
    assertEquals(1, manager.activeNotifications.size)
  }

  @Test
  fun disablingPreservesEnrollmentButRejectsDeliveryImmediately() {
    val instance = enroll()
    val before = SelfHostedPush.enrollment(context, "environment")
    SelfHostedPush.disable(context, "environment")
    assertFalse(SelfHostedPush.isSelected(context))
    SelfHostedPush.onMessage(context, messageFrom(before), instance)
    assertTrue(manager.activeNotifications.isEmpty())
    assertEquals(instance, SelfHostedPush.prepare(context, "environment", origin, "t3code-dev"))
    assertEquals(before, SelfHostedPush.enrollment(context, "environment"))
  }

  private fun messageFrom(enrollment: String): PushMessage {
    val entry = JSONObject(enrollment)
    return PushMessage(JSONObject()
      .put("device_id", entry.getString("installationId"))
      .put("user_id", "self-hosted")
      .put("environment_id", entry.getString("environmentId"))
      .put("registration_id", SelfHostedPush.registrationId(entry.getString("endpoint"), entry.getString("p256dh"), entry.getString("auth")))
      .put("updated_at", System.currentTimeMillis().toString())
      .put("alert_id", "disabled-alert")
      .put("alert_title", "Disabled")
      .put("alert_body", "Must not render")
      .put("alert_path", "/threads/${Uri.encode(entry.getString("environmentId"))}/thread")
      .toString().toByteArray(Charsets.UTF_8), true)
  }

  @Test(expected = IllegalArgumentException::class)
  fun registrationsCannotUseDifferentNtfyOrigins() {
    enroll()
    SelfHostedPush.prepare(context, "other", "https://other.example.com", "t3code-dev")
  }

  @Test
  fun endpointsRejectedByThePublisherCannotReplaceThePendingRegistration() {
    val instance = enroll()
    val enrollment = JSONObject(SelfHostedPush.enrollment(context, "environment"))
    val keys = PublicKeySet(enrollment.getString("p256dh"), enrollment.getString("auth"))
    for (invalid in listOf(
      "$origin/upshort?up=1",
      "$origin/upExample12345",
      "$origin/upExample_2345?up=1",
      "$origin/upExample12345?up=1&other=1"
    )) {
      SelfHostedPush.onNewEndpoint(context, PushEndpoint(invalid, keys, false), instance)
      val status = JSONObject(SelfHostedPush.status(context)).getJSONArray("environments").getJSONObject(0)
      assertEquals("error", status.getString("state"))
      assertEquals(endpoint, JSONObject(SelfHostedPush.enrollment(context, "environment")).getString("endpoint"))
    }
  }

  @Test
  fun foreignEndpointDoesNotExposeEnrollmentKeys() {
    val instance = SelfHostedPush.prepare(context, "environment", origin, "t3code-dev")
    SelfHostedPush.onNewEndpoint(
      context, PushEndpoint("https://other.example.com/upExample", null, false), instance
    )
    assertTrue(SelfHostedPush.status(context).contains("error"))
    assertFalse(SelfHostedPush.status(context).contains("p256dh"))
    assertTrue(manager.activeNotifications.isEmpty())
  }

  @Test
  fun wrongRecipientsRoutesAndOldOrMalformedPayloadsDoNotVerifyEnrollment() {
    val instance = enroll()
    val valid = message()
    val invalid = listOf(
      patched(valid, "device_id" to "another-phone"),
      patched(valid, "user_id" to "cloud-user"),
      patched(valid, "registration_id" to "unknown-registration"),
      patched(valid, "alert_path" to "/threads/other/thread"),
      patched(valid, "updated_at" to "0"),
      PushMessage(byteArrayOf(0xff.toByte()), true)
    )
    invalid.forEach { SelfHostedPush.onMessage(context, it, instance) }
    assertTrue(manager.activeNotifications.isEmpty())
    assertTrue(SelfHostedPush.status(context).contains("needsAcl"))
  }

  @Test
  fun sameUrlKeyRotationCannotBeVerifiedByAnOldMessage() {
    val instance = enroll()
    val oldMessage = message()
    SelfHostedPush.onMessage(context, oldMessage, instance)
    val old = JSONObject(SelfHostedPush.enrollment(context, "environment"))
    val newAuth = Base64.encodeToString(ByteArray(16) { 1 },
      Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    SelfHostedPush.onNewEndpoint(context,
      PushEndpoint(endpoint, PublicKeySet(old.getString("p256dh"), newAuth), false), instance)
    SelfHostedPush.onMessage(context, oldMessage, instance)
    assertTrue(SelfHostedPush.status(context).contains("needsAcl"))
    SelfHostedPush.onMessage(context, message(), instance)
    assertTrue(SelfHostedPush.status(context).contains("verified"))
  }

  @Test
  fun disablingOneEnvironmentDoesNotDismissOrDisableAnother() {
    val first = enroll()
    val firstMessage = message()
    SelfHostedPush.onMessage(context, firstMessage, first)
    val other = enroll("environment:other")
    SelfHostedPush.onMessage(context, message("environment:other"), other)
    assertEquals(2, manager.activeNotifications.size)
    SelfHostedPush.disable(context, "environment")
    assertEquals(1, manager.activeNotifications.size)
    SelfHostedPush.onMessage(context, firstMessage, first)
    assertEquals(1, manager.activeNotifications.size)
    assertTrue(SelfHostedPush.isSelected(context))
  }

  @Test
  fun unknownOrRepeatedDisableCannotClearCloudConfiguration() {
    SelfHostedPush.disable(context, "unknown")
    AgentNotifications.receive(context, update("cloud-first", false))
    assertEquals(1, manager.activeNotifications.count { it.tag == "t3-agent-alert" })
    enroll()
    SelfHostedPush.disable(context, "environment")
    AgentNotifications.configure(context, "device", "user", "t3code-dev", true)
    SelfHostedPush.disable(context, "environment")
    AgentNotifications.receive(context, update("cloud-after", false))
    assertEquals(1, manager.activeNotifications.count { it.tag == "t3-agent-alert" })
  }
}
