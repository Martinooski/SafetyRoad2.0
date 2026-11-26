package cl.safetyroad.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL

class MainActivity : Activity() {
    private lateinit var web: WebView
    private val host = "appassets.androidplatform.net"

    /** Puente de red para entorno de prueba: WebView permanece en origen HTTPS local. */
    inner class SafetyRoadBridge {
        @JavascriptInterface
        fun request(id: String, method: String, route: String, payload: String, serverUrl: String) {
            Thread {
                var code = 0
                var body = ""
                try {
                    // Solo endpoints declarados y servidores con IP IPv4 privada, puerto 8765.
                    val allowedGet = route == "/api/salud" || route == "/api/app/indicadores" ||
                        route.startsWith("/api/app/seguimiento?token=")
                    val allowedPost = route == "/api/app/reportar"
                    if ((method != "GET" || !allowedGet) && (method != "POST" || !allowedPost))
                        throw IllegalArgumentException("Ruta/API no autorizada")
                    val server = URL(serverUrl.trim().trimEnd('/'))
                    val ipText = server.host
                    if (!ipText.matches(Regex("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) ||
                        server.protocol != "http" || server.port != 8765 ||
                        server.userInfo != null || server.query != null || server.ref != null ||
                        server.path !in listOf("", "/"))
                        throw IllegalArgumentException("Usa http://IP_PRIVADA:8765")
                    val ip = InetAddress.getByName(ipText)
                    if (!ip.isSiteLocalAddress)
                        throw IllegalArgumentException("Solo se admiten redes locales privadas")
                    val endpoint = URL(server.toString().trimEnd('/') + route)
                    val conn = endpoint.openConnection() as HttpURLConnection
                    try {
                        conn.instanceFollowRedirects = false
                        conn.requestMethod = method
                        conn.connectTimeout = 7000
                        conn.readTimeout = 10000
                        if (method == "POST") {
                            conn.doOutput = true
                            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                            conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                        }
                        code = conn.responseCode
                        body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                            ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
                            ?: "{\"error\":\"Respuesta vacía\"}"
                    } finally { conn.disconnect() }
                } catch (ex: Exception) {
                    body = JSONObject().put("error", ex.message ?: "No se pudo conectar con Python").toString()
                }
                val detail = JSONObject().put("id", id).put("code", code).put("body", body).toString()
                web.post {
                    // Escapado robusto: el JSON se pasa como string codificada, no HTML.
                    val js = "window.dispatchEvent(new CustomEvent('safetyroad-response',{detail:JSON.parse(" +
                        JSONObject.quote(detail) + ")}));"
                    web.evaluateJavascript(js, null)
                }
            }.start()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                1
            )
        }

        // Sirve los archivos de la app por https para que GPS y sensores funcionen
        val loader = WebViewAssetLoader.Builder()
            .setDomain(host)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this)
        web.fitsSystemWindows = true
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.setGeolocationEnabled(true)
        web.addJavascriptInterface(SafetyRoadBridge(), "SafetyRoadBridge")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.scheme == "tel") {
                    startActivity(Intent(Intent.ACTION_DIAL, u))
                    return true
                }
                if ((u.scheme == "http" || u.scheme == "https") && u.host != host) {
                    startActivity(Intent(Intent.ACTION_VIEW, u))
                    return true
                }
                return false
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, cb: GeolocationPermissions.Callback) {
                cb.invoke(origin, origin.trimEnd('/') == "https://$host", false)
            }
        }
        setContentView(web)
        web.loadUrl("https://$host/assets/www/index.html")
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (::web.isInitialized && grantResults.any { it == PackageManager.PERMISSION_GRANTED }) web.reload()
    }
}
