# Keep file/line info so release crash traces are readable; the mapping.txt
# uploaded to Play Console handles deobfuscating class/method names.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# GeckoView's debug-config path (taken whenever the device marks this app as
# its "debug app", e.g. Play pre-launch testing) loads GeckoView's bundled
# SnakeYAML, whose static initializers call getClass().getPackage().getName().
# R8's default repackaging moves those classes into the root package, making
# getPackage() return null and crashing GeckoRuntime.create() at startup with
# ExceptionInInitializerError. GeckoView's consumer rules only -dontwarn
# SnakeYAML (Mozilla bug 1838031), so keep it intact here.
-keep class org.yaml.snakeyaml.** { *; }
