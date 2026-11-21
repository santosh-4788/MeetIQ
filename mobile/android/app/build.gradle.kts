import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing key: kept OUTSIDE the repository (C:\Android\keys\keystore.properties by default, or the
// OIC_KEYSTORE_PROPERTIES environment variable). Never commit it; losing it means existing installs cannot be updated.
val keystorePropsFile = file(System.getenv("OIC_KEYSTORE_PROPERTIES") ?: "C:/Android/keys/keystore.properties")
val keystoreProps = Properties().apply { if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) } }

android {
    namespace = "com.oneinsure.connect"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.oneinsure.connect"
        minSdk = 26          // Android 8.0+
        targetSdk = 35
        versionCode = 5
        versionName = "1.2.1"
        // The portal the app opens. Only this host + path prefix is loaded inside the app; everything else opens outside.
        buildConfigField("String", "PORTAL_URL", "\"https://www.oneinsure.com/meet/\"")
        buildConfigField("String", "PORTAL_HOST", "\"www.oneinsure.com\"")
        buildConfigField("String", "PORTAL_PATH", "\"/meet\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (keystoreProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    // One APK for every phone: 64-bit and 32-bit ARM only (WebRTC ships native code per CPU type; Intel-chip code is left
    // out - no phones use it - which keeps the download ~35 MB instead of ~58 MB).
    defaultConfig { ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") } }

    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint {
        abortOnError = true
        warningsAsErrors = false
        checkReleaseBuilds = true
    }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // Phone screen sharing to OUR video server (Apache 2.0, no cloud service).
    implementation("io.livekit:livekit-android:2.30.0")

    testImplementation("junit:junit:4.13.2")
}
