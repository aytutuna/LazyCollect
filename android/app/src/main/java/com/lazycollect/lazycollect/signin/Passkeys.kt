package com.lazycollect.lazycollect.signin

import android.content.Context
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.domerrors.InvalidStateError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import com.lazycollect.lazycollect.net.ApiJson
import kotlinx.serialization.json.JsonObject

/** Why a passkey could not be used, as the sign-in screen words it: cancelled, already, none or unusable. */
class PasskeyFailed(val reason: String) : Exception(reason)

/** The phone's passkey prompt, taking and giving the WebAuthn JSON the server speaks. */
interface Passkeys {
    suspend fun create(host: Context, options: JsonObject): JsonObject

    suspend fun get(host: Context, options: JsonObject): JsonObject
}

class CredentialPasskeys : Passkeys {
    override suspend fun create(host: Context, options: JsonObject): JsonObject {
        try {
            val result = CredentialManager.create(host).createCredential(host, CreatePublicKeyCredentialRequest(options.toString()))
            return ApiJson.decodeFromString((result as CreatePublicKeyCredentialResponse).registrationResponseJson)
        } catch (e: CreateCredentialCancellationException) {
            throw PasskeyFailed("cancelled")
        } catch (e: CreatePublicKeyCredentialDomException) {
            throw PasskeyFailed(if (e.domError is InvalidStateError) "already" else "unusable")
        } catch (e: CreateCredentialException) {
            throw PasskeyFailed("unusable")
        }
    }

    override suspend fun get(host: Context, options: JsonObject): JsonObject {
        try {
            val result = CredentialManager.create(host).getCredential(host, GetCredentialRequest(listOf(GetPublicKeyCredentialOption(options.toString()))))
            return ApiJson.decodeFromString((result.credential as PublicKeyCredential).authenticationResponseJson)
        } catch (e: GetCredentialCancellationException) {
            throw PasskeyFailed("cancelled")
        } catch (e: NoCredentialException) {
            throw PasskeyFailed("none")
        } catch (e: GetCredentialException) {
            throw PasskeyFailed("unusable")
        }
    }
}
