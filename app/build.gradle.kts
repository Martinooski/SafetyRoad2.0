plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "cl.safetyroad.app"
    compileSdk = 34
    defaultConfig {
        applicationId = "cl.safetyroad.app.demo"
        minSdk = 24
        targetSdk = 34
        versionCode = 3
        versionName = "2.0-sin-yolo"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
}
