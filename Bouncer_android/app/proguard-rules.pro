# Keep file/line info so release crash traces are readable; the mapping.txt
# uploaded to Play Console handles deobfuscating class/method names.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
