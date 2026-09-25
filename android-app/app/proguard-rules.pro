# Keep models for Gson
-keep class com.edringcolony.monitor.data.model.** { *; }
-keep class com.google.gson.** { *; }
-keepattributes Signature, InnerClasses, EnclosingMethod
-keepattributes *Annotation*
-dontwarn com.google.gson.**
