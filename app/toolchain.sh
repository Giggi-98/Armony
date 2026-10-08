#!/bin/sh
# Armony: strumenti per costruire l'app Android su Linux x64, a versione fissa, in una cartella sola.
# Uso: app/toolchain.sh [cartella]   (predefinita /opt/armony-android)
# Poi: . <cartella>/env.sh   per avere node, java e l'Android SDK nel PATH.
# La GitHub Action non lo usa: lì gli stessi strumenti arrivano dalle azioni setup-*.
set -eu
D=${1:-/opt/armony-android}
NODE=v22.23.3
JDK_URL=https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz
SDK_TOOLS=commandlinetools-linux-15859902_latest.zip
mkdir -p "$D" && cd "$D"
get() { [ -f "$2" ] || curl -fsSL -o "$2" "$1"; }

# Node, verificato con SHASUMS256 ufficiale
get "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" node.tar.xz
get "https://nodejs.org/dist/$NODE/SHASUMS256.txt" node.sha
grep " node-$NODE-linux-x64.tar.xz\$" node.sha | awk '{print $1"  node.tar.xz"}' | sha256sum -c -
[ -d node ] || { mkdir node && tar -xJf node.tar.xz -C node --strip-components=1; }

# JDK Temurin, verificato con il checksum pubblicato accanto al file
get "$JDK_URL" jdk.tar.gz
get "$JDK_URL.sha256.txt" jdk.sha
awk '{print $1"  jdk.tar.gz"}' jdk.sha | sha256sum -c -
[ -d jdk ] || { mkdir jdk && tar -xzf jdk.tar.gz -C jdk --strip-components=1; }

# Android SDK: command-line tools, poi piattaforma e build-tools richiesti da Capacitor 8
get "https://dl.google.com/android/repository/$SDK_TOOLS" sdktools.zip
if [ ! -d sdk/cmdline-tools/latest ]; then
  mkdir -p sdk/cmdline-tools && python3 -c "import zipfile;zipfile.ZipFile('sdktools.zip').extractall('sdk/cmdline-tools')"
  mv sdk/cmdline-tools/cmdline-tools sdk/cmdline-tools/latest && chmod +x sdk/cmdline-tools/latest/bin/*
fi
cat > env.sh <<ENV
export JAVA_HOME="$D/jdk" ANDROID_HOME="$D/sdk" ANDROID_SDK_ROOT="$D/sdk"
export PATH="$D/node/bin:$D/jdk/bin:$D/sdk/cmdline-tools/latest/bin:$D/sdk/platform-tools:\$PATH"
ENV
. ./env.sh
yes | sdkmanager --licenses >/dev/null
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "build-tools;35.0.0" >/dev/null
echo "Pronto: . $D/env.sh"
