import java.net.URI
import java.security.MessageDigest
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
        versionCode = 5
        versionName = "1.0.4"

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
            isMinifyEnabled = false
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
        // The AI-text classifier head, shared with iOS (the iOS folder is the
        // single source of truth, same as ChromePolyfill.js). Lands at the
        // assets root, next to web_ext_gecko/.
        iosShell.resolve("detector_head_e2b_v2.bin")
            .copyTo(root.resolve("detector_head_e2b_v2.bin"), overwrite = true)
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
        iosShell.resolve("detector_head_e2b_v2.bin"),
    )
    outputDir.set(layout.buildDirectory.dir("generated/bouncerAssets"))
}

// The custom LiteRT-LM Android runtime (Kotlin API + arm64 JNI + GPU accelerator
// libs), built from millanatimbue/LiteRT-LM branch release/android by
// tools/package_android_aar.sh and published as a GitHub release asset.
// Downloaded once into .litertlm/ (gitignored; survives `clean`) and verified
// against a pinned SHA-256.
val litertlmAarUrl =
    "https://github.com/millanatimbue/LiteRT-LM/releases/download/android-v1/litertlm-android.aar"
val litertlmAarSha256 = "aa835192de2b9487671816598c24d930ca2c17b2aa85d66675acb46a6e57fcb1"
val litertlmAarFile = rootProject.layout.projectDirectory.file(".litertlm/litertlm-android.aar")

val downloadLitertlmAar = tasks.register("downloadLitertlmAar") {
    outputs.file(litertlmAarFile)
    doLast {
        val target = litertlmAarFile.asFile
        fun sha256(f: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            f.inputStream().use { ins ->
                val buf = ByteArray(1 shl 20)
                while (true) {
                    val n = ins.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { b -> "%02x".format(b) }
        }
        if (target.exists() && sha256(target) == litertlmAarSha256) return@doLast
        target.parentFile.mkdirs()
        logger.lifecycle("Downloading litertlm-android.aar from $litertlmAarUrl")
        URI(litertlmAarUrl).toURL().openStream().use { input ->
            target.outputStream().use { out -> input.copyTo(out) }
        }
        val actual = sha256(target)
        check(actual == litertlmAarSha256) {
            target.delete()
            "litertlm-android.aar SHA-256 mismatch: expected $litertlmAarSha256, got $actual"
        }
    }
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
    implementation(files(downloadLitertlmAar.map { it.outputs.files }))
    // Runtime deps of the litertlm-android AAR (a plain file dependency carries
    // no POM, so its dependencies are declared here).
    implementation(libs.gson)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlin.reflect)
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
