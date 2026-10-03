import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Orbital's Kotlin Multiplatform module: the rows the engine answers with, the Engine that asks for them, and every
// screen in Compose Multiplatform. android is the app; jvm (desktop) runs the same screens headless in jvmTest.
plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidKotlinMultiplatformLibrary)
    alias(libs.plugins.kotlinSerialization)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
}

kotlin {
    // The desktop target's bytecode fixed at 17 whatever JDK runs Gradle (this Mac has only 27, which Kotlin cannot
    // target yet and fell back from). Not a jvmToolchain: that would need a second JDK found or downloaded here.
    jvm { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }

    android {
        namespace = "com.dreetje.orbital.shared"
        compileSdk = libs.versions.compileSdk.get().toInt()
        minSdk = libs.versions.minSdk.get().toInt()
    }

    compilerOptions {
        optIn.addAll("kotlin.time.ExperimentalTime", "androidx.compose.material3.ExperimentalMaterial3Api", "androidx.compose.foundation.ExperimentalFoundationApi")
    }

    sourceSets {
        commonMain.dependencies {
            api(libs.compose.runtime)
            api(libs.compose.foundation)
            api(libs.compose.ui)
            api(libs.compose.material3)
            api(libs.compose.material.icons)
            api(libs.kotlinx.coroutines.core)
            api(libs.kotlinx.serialization.json)
            implementation(libs.kotlinx.datetime)
        }
        androidMain.dependencies {
            implementation(libs.androidx.activity.compose)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.kotlinx.coroutines.test)
        }
        jvmTest.dependencies {
            implementation(libs.compose.ui.test)
            implementation(compose.desktop.currentOs)
            implementation(libs.kotlinx.coroutines.swing)
        }
    }
}

tasks.withType<JavaCompile>().configureEach { options.release.set(17) } // the same target as Kotlin's, as Gradle checks

// the repository the tests read the iPhone's samples from (SampleTest sampleFile), whatever directory they run in
tasks.withType<Test>().configureEach { systemProperty("orbital.repo", rootDir.parentFile.absolutePath) }
