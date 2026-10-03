import javax.inject.Inject

// The Android app: the Activity, the web view the engine runs in (EngineWeb), and the platform's services (ChatGPT,
// the microphone, the shake, the photo picker). The screens are the shared module's.
plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.composeCompiler)
}

// The engine the iPhone app runs (ios/engine, bundled by Bun from sdk/ and main/), and the iPhone's invented sample
// content (ios/Orbital/*-sample.json), into the app's assets: one engine and one sample for both phones.
abstract class OrbitalAssets @Inject constructor(private val exec: ExecOperations) : DefaultTask() {
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) abstract val sources: ConfigurableFileCollection
    @get:Internal abstract val repo: DirectoryProperty
    @get:Input abstract val bun: Property<String>
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
    sources.from(fileTree(root.resolve("ios/engine")), fileTree(root.resolve("sdk")), fileTree(root.resolve("main")),
        root.resolve("renderer/segments.js"), root.resolve("ios/Orbital/timeline-sample.json"), root.resolve("ios/Orbital/pages-sample.json"),
        root.resolve("package-lock.json"))
    // the Nucleo set behind Set icon, which the engine takes in when it is there (ios/engine/build.js; scripts/build-nucleo.js
    // makes it from the local Nucleo library): a tree, so its turning up later builds the engine again, and none is fine
    sources.from(fileTree(root.resolve("build")) { include("nucleo-ui.json.gz") })
    output.set(layout.buildDirectory.dir("generated/orbital"))
}

android {
    namespace = "com.dreetje.orbital.android"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "com.dreetje.orbital"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.compileSdk.get().toInt()
        versionCode = 1
        versionName = "0.9.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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
    implementation(libs.kotlinx.coroutines.android)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.uiautomator)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.compose.ui.test.junit4.android)
    debugImplementation(libs.compose.ui.test.manifest)
}
