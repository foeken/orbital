import javax.inject.Inject

// The Android app: the Activity, the web view the engine runs in (EngineWeb), and the platform's services (ChatGPT,
// the microphone, the shake, the photo picker). The screens are the shared module's.
plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.composeCompiler)
    // ChatGPTClient's own @Serializable classes (the tokens, the model list): without it they have no serializer and an
    // accepted ChatGPT sign-in failed on the phone
    alias(libs.plugins.kotlinSerialization)
}

// The engine the iPhone app runs (ios/engine, bundled by Bun from sdk/ and main/), and the iPhone's invented sample
// content (ios/Orbital/*-sample.json), into the app's assets: one engine and one sample for both phones.
abstract class OrbitalAssets @Inject constructor(private val exec: ExecOperations) : DefaultTask() {
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) abstract val sources: ConfigurableFileCollection
    @get:Internal abstract val repo: DirectoryProperty
    @get:Input abstract val bun: Property<String>
    // the commit the engine names to Tana (source.js): a new one bundles it again, though no source changed
    @get:Input abstract val commit: Property<String>
    @get:OutputDirectory abstract val output: DirectoryProperty

    @TaskAction fun bundle() {
        val out = output.get().asFile
        out.deleteRecursively()
        out.mkdirs()
        val root = repo.get().asFile
        exec.exec {
            workingDir = root
            commandLine(bun.get(), "ios/engine/build.js", File(out, "engine.js").path)
        }
        for (name in listOf("timeline-sample.json", "pages-sample.json")) File(root, "ios/Orbital/" + name).copyTo(File(out, name))
    }
}

val orbitalAssets = tasks.register<OrbitalAssets>("orbitalAssets") {
    val root = rootDir.parentFile
    repo.set(root)
    bun.set(providers.gradleProperty("orbital.bun").orElse("bun"))
    commit.set(providers.exec { workingDir = root; commandLine("git", "rev-parse", "HEAD"); isIgnoreExitValue = true }.standardOutput.asText)
    sources.from(fileTree(root.resolve("ios/engine")), fileTree(root.resolve("sdk")), fileTree(root.resolve("main")),
        root.resolve("renderer/segments.js"), root.resolve("source.js"), root.resolve("ios/Orbital/timeline-sample.json"), root.resolve("ios/Orbital/pages-sample.json"),
        root.resolve("package-lock.json"))
    // the Nucleo set behind Set icon, which the engine takes in when it is there (ios/engine/build.js; scripts/build-nucleo.js
    // makes it from the local Nucleo library): a tree, so its turning up later builds the engine again, and none is fine
    sources.from(fileTree(root.resolve("build")) { include("nucleo-ui.json.gz") })
    output.set(layout.buildDirectory.dir("generated/orbital"))
}

// The version is the desktop's: package.json's, which npm version bumps (scripts/release.sh) and every release is tagged
// with. versionCode, which has to grow for a phone to take an APK as an update, is read off it: 0.10.0 is 10000, 1.2.3 is
// 1002003, so minor and patch stay under 1000.
val orbitalVersion = providers.fileContents(layout.projectDirectory.file("../../package.json")).asText.map { json ->
    val (major, minor, patch) = Regex("\"version\"\\s*:\\s*\"(\\d+)\\.(\\d+)\\.(\\d+)\"").find(json)?.destructured
        ?: error("package.json has no x.y.z version")
    check(minor.toInt() < 1000 && patch.toInt() < 1000) { "versionCode needs minor and patch under 1000" }
    "$major.$minor.$patch" to major.toInt() * 1_000_000 + minor.toInt() * 1_000 + patch.toInt()
}

// The release key (scripts/android-release.sh hands it over): a keystore outside the repo, never in it. Without one the
// release build is unsigned (CI's), and nothing installs it.
val releaseKey = providers.environmentVariable("ORBITAL_ANDROID_KEYSTORE")

android {
    namespace = "com.dreetje.orbital.android"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "com.dreetje.orbital"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.compileSdk.get().toInt()
        versionName = orbitalVersion.get().first
        versionCode = orbitalVersion.get().second
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (releaseKey.isPresent) create("release") {
            storeFile = file(releaseKey.get())
            storePassword = providers.environmentVariable("ORBITAL_ANDROID_KEYSTORE_PASSWORD").get()
            keyAlias = providers.environmentVariable("ORBITAL_ANDROID_KEY_ALIAS").get()
            keyPassword = providers.environmentVariable("ORBITAL_ANDROID_KEY_PASSWORD").get()
        }
    }

    buildTypes {
        // no shrinking: the engine's bridge and the serializers are reached by name
        release { if (releaseKey.isPresent) signingConfig = signingConfigs.getByName("release") }
    }

    buildFeatures { compose = true }

    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

androidComponents {
    onVariants { variant -> variant.sources.assets?.addGeneratedSourceDirectory(orbitalAssets, OrbitalAssets::output) }
}

dependencies {
    implementation(project(":shared"))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.glance.appwidget)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.uiautomator)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.compose.ui.test.junit4.android)
    androidTestImplementation(libs.androidx.glance.appwidget.testing)
    debugImplementation(libs.compose.ui.test.manifest)
}
