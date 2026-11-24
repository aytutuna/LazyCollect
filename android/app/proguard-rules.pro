# kotlinx.serialization and OkHttp ship their own consumer rules.
-keepclassmembers class com.lazycollect.lazycollect.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepattributes *Annotation*, InnerClasses
