plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.roborazzi)
}

// The debug build reaches wrangler dev through the emulator's alias for the host unless -Pcollect.apiBase says otherwise.
val debugApiBase = (findProperty("collect.apiBase") as String?) ?: "http://10.0.2.2:8787"

// TODO: Play Integrity needs the Cloud project number of lazy-collect, which is not linked in Play Console yet.
val cloudProject = (findProperty("collect.cloudProject") as String?) ?: "0"

// The notices file lives at the repo root, shared with the server and web app, and goes into the APK as an asset.
val notices = tasks.register<Copy>("copyNotices") {
    from(rootDir.resolve("../THIRD-PARTY-NOTICES.txt"))
    into(layout.buildDirectory.dir("generated/notices"))
}

// The corner model is fetched, not checked in (scripts/fetch_docaligner.sh). Unit tests run without it; an APK or bundle without it would
// ship a scanner that finds no page, so packaging stops.
val cornerModel = tasks.register<Copy>("copyCornerModel") {
    from(rootDir.resolve("models")) { include("*.onnx") }
    into(layout.buildDirectory.dir("corner-model"))
}

val checkCornerModel = tasks.register("checkCornerModel") {
    val model = rootDir.resolve("models/fastvit_t8_h_e_bifpn_256_fp32.onnx")
    doLast {
        if (!model.exists()) throw GradleException("The corner model is missing: run android/scripts/fetch_docaligner.sh")
    }
}

tasks.named("preBuild") { dependsOn(notices, cornerModel) }

tasks.configureEach {
    if (name in setOf("packageDebug", "packageRelease", "bundleDebug", "bundleRelease")) dependsOn(checkCornerModel)
}

android {
    namespace = "com.lazycollect.lazycollect"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.lazycollect.lazycollect"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("long", "CLOUD_PROJECT", "${cloudProject}L")
        ndk {
            abiFilters += setOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            buildConfigField("String", "API_BASE", "\"$debugApiBase\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "API_BASE", "\"https://collect.alazy.app\"")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all { test ->
                test.systemProperty("robolectric.logging.enabled", "false")
                (findProperty("collect.shotsDir") as String?)?.let { test.systemProperty("collect.shotsDir", it) }
                test.maxHeapSize = "3g"
                // Robolectric reaches into JDK internals that newer JDKs close by default.
                test.jvmArgs(
                    "--add-opens=java.base/java.io=ALL-UNNAMED",
                    "--add-opens=java.base/java.lang=ALL-UNNAMED",
                    "--add-opens=java.base/java.util=ALL-UNNAMED",
                    "--add-opens=java.base/java.nio=ALL-UNNAMED",
                    "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED",
                    "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED",
                    "--add-opens=java.base/jdk.internal.access=ALL-UNNAMED",
                    "--enable-native-access=ALL-UNNAMED",
                )
            }
        }
    }

    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/notices").get().asFile)
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("corner-model").get().asFile)

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/LICENSE*")
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.navigation.compose)
    implementation(libs.core.ktx)
    implementation(libs.credentials)
    implementation(libs.credentials.play.services)
    implementation(libs.play.integrity)
    implementation(libs.work.runtime)
    implementation(libs.exifinterface)
    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.onnxruntime.android)

    implementation(libs.okhttp)
    implementation(libs.okhttp.coroutines)
    implementation(libs.serialization.json)
    implementation(libs.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.roborazzi.junit.rule)
}
