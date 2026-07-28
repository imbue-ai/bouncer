import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.google.services)
}

val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

val releaseStoreFile = localProps.getProperty("BOUNCER_RELEASE_STORE_FILE")
val releaseStorePassword = localProps.getProperty("BOUNCER_RELEASE_STORE_PASSWORD")
val releaseKeyAlias = localProps.getProperty("BOUNCER_RELEASE_KEY_ALIAS")
val releaseKeyPassword = localProps.getProperty("BOUNCER_RELEASE_KEY_PASSWORD")
val hasReleaseSigning = releaseStoreFile != null &&
    releaseStorePassword != null &&
    releaseKeyAlias != null &&
    releaseKeyPassword != null &&
    file(releaseStoreFile).exists()

android {
    namespace = "com.imbue.bouncer"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "com.imbue.bouncer"
        minSdk = 26
        targetSdk = 36
        versionCode = 8
        versionName = "1.0.7"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        val debugToken = localProps.getProperty("firebaseAppCheckDebugToken", "")
        buildConfigField("String", "APP_CHECK_DEBUG_TOKEN", "\"$debugToken\"")

        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                logger.warn(
                    "BOUNCER_RELEASE_* signing properties not found in local.properties; " +
                        "release builds will be signed with the debug keystore. " +
                        "This is fine for local testing but will fail Play Integrity attestation."
                )
                signingConfigs.getByName("debug")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }

    androidResources {
        noCompress += listOf("mp4")
    }
}

@org.gradle.api.tasks.CacheableTask
abstract class CopyExtensionAssetsTask : org.gradle.api.DefaultTask() {
    @get:org.gradle.api.tasks.InputFiles
    @get:org.gradle.api.tasks.PathSensitive(org.gradle.api.tasks.PathSensitivity.RELATIVE)
    abstract val sources: org.gradle.api.file.ConfigurableFileCollection

    @get:org.gradle.api.tasks.OutputDirectory
    abstract val outputDir: org.gradle.api.file.DirectoryProperty

    @get:org.gradle.api.tasks.Internal
    abstract val bouncerDir: org.gradle.api.file.DirectoryProperty

    @get:org.gradle.api.tasks.Internal
    abstract val iosShellDir: org.gradle.api.file.DirectoryProperty

    @org.gradle.api.tasks.TaskAction
    fun run() {
        val bouncer = bouncerDir.get().asFile
        val iosShell = iosShellDir.get().asFile
        check(bouncer.resolve("dist/content.js").exists()) {
            "Bouncer/dist/ not built. Run: (cd ${bouncer.absolutePath} && npm install && npm run build)"
        }
        check(iosShell.resolve("ChromePolyfill.js").exists()) {
            "Missing ChromePolyfill.js at ${iosShell.absolutePath}"
        }
        val root = outputDir.get().asFile
        if (root.exists()) root.deleteRecursively()
        val out = root.resolve("web_ext_gecko")
        out.mkdirs()
        listOf("background-app.js", "content.js", "TwitterAdapter.js", "popup-app.js").forEach { name ->
            bouncer.resolve("dist/$name").copyTo(out.resolve("dist/$name").also { it.parentFile.mkdirs() }, overwrite = true)
        }
        listOf("dompurify.js", "content.css", "popup.html", "popup.css").forEach { name ->
            bouncer.resolve(name).copyTo(out.resolve(name), overwrite = true)
        }
        bouncer.resolve("adapters/twitter/twitter.css").copyTo(
            out.resolve("adapters/twitter/twitter.css").also { it.parentFile.mkdirs() },
            overwrite = true,
        )
        bouncer.resolve("adapters/twitter/fiber-extractor.js").copyTo(
            out.resolve("adapters/twitter/fiber-extractor.js").also { it.parentFile.mkdirs() },
            overwrite = true,
        )
        iosShell.resolve("ChromePolyfill.js").copyTo(out.resolve("ChromePolyfill.js"), overwrite = true)
    }
}

// Rebuild the extension JS before packaging it, so the APK can never ship a
// stale Bouncer/dist (gradle only ever copied dist/, it never rebuilt it).
// Runs through a login shell because Android Studio's Gradle daemon doesn't
// inherit the interactive PATH, so plain "npm" wouldn't resolve under nvm or
// Homebrew installs.
val buildExtensionJs = tasks.register<Exec>("buildExtensionJs") {
    val bouncer = rootDir.parentFile.resolve("Bouncer")
    workingDir = bouncer
    if (System.getProperty("os.name").startsWith("Windows")) {
        commandLine("cmd", "/c", "npm run build")
    } else {
        commandLine("/bin/zsh", "-lc", "([ -d node_modules ] || npm install) && npm run build")
    }
    inputs.dir(bouncer.resolve("src"))
    inputs.dir(bouncer.resolve("adapters"))
    inputs.files(
        bouncer.resolve("build.js"),
        bouncer.resolve("generate-manifests.mjs"),
        bouncer.resolve("manifest.base.json"),
        bouncer.resolve("package.json"),
        bouncer.resolve("package-lock.json"),
    )
    // .env* select the backend and are baked into the bundles as defines.
    inputs.files(fileTree(bouncer) { include(".env*") })
    outputs.dir(bouncer.resolve("dist"))
}

val copyExtensionAssets = tasks.register<CopyExtensionAssetsTask>("copyExtensionAssets") {
    dependsOn(buildExtensionJs)
    val bouncer = rootDir.parentFile.resolve("Bouncer")
    val iosShell = rootDir.parentFile.resolve("Bouncer_xcode/iOS (App)")
    bouncerDir.set(bouncer)
    iosShellDir.set(iosShell)
    sources.from(
        bouncer.resolve("dist/background-app.js"),
        bouncer.resolve("dist/content.js"),
        bouncer.resolve("dist/TwitterAdapter.js"),
        bouncer.resolve("dist/popup-app.js"),
        bouncer.resolve("dompurify.js"),
        bouncer.resolve("content.css"),
        bouncer.resolve("popup.html"),
        bouncer.resolve("popup.css"),
        bouncer.resolve("adapters/twitter/twitter.css"),
        bouncer.resolve("adapters/twitter/fiber-extractor.js"),
        iosShell.resolve("ChromePolyfill.js"),
    )
    outputDir.set(layout.buildDirectory.dir("generated/bouncerAssets"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(
            copyExtensionAssets,
            CopyExtensionAssetsTask::outputDir,
        )
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.fragment)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.ui)
    implementation(libs.okhttp)
    implementation(libs.geckoview)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.appcheck)
    implementation(libs.firebase.appcheck.playintegrity)
    implementation(libs.firebase.appcheck.debug)
    testImplementation(libs.junit)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
