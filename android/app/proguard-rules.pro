# kotlinx.serialization and OkHttp ship their own consumer rules; ONNX Runtime's native code finds its Java classes by name.
-keep class ai.onnxruntime.** { *; }
-keepclassmembers class com.lazycollect.lazycollect.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepattributes *Annotation*, InnerClasses
