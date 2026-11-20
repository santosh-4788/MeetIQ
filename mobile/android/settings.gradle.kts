// OneInsure Connect - Android app (portal in a secure WebView + phone screen sharing).
// Free and open-source build tools and libraries only (Android SDK, Gradle, AndroidX, LiveKit Android - Apache 2.0).
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // LiveKit's audio-routing helper (audioswitch) is published on JitPack (free, public).
        maven("https://jitpack.io") { content { includeGroup("com.github.davidliu") } }
    }
}
rootProject.name = "OneInsureConnect"
include(":app")
