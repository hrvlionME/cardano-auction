#!/usr/bin/env bash
# Builds the C libraries plutus-core / cardano-crypto-class links against.
# Needs sudo for the `make install` steps -> run this yourself, not via an agent.
set -euo pipefail

SRC="${SRC:-$HOME/src/cardano-libs}"
mkdir -p "$SRC"

# --- libsodium (IOG fork: adds the VRF + extended-ed25519 primitives) ---------
if [ ! -d "$SRC/libsodium" ]; then
  git clone https://github.com/IntersectMBO/libsodium "$SRC/libsodium"
fi
cd "$SRC/libsodium"
git checkout dbb48cc               # pinned by cardano-base
./autogen.sh -s
./configure
make -j"$(nproc)"
sudo make install

# --- libsecp256k1 (needs schnorrsig + ecdh, not enabled in the distro build) --
if [ ! -d "$SRC/secp256k1" ]; then
  git clone https://github.com/bitcoin-core/secp256k1 "$SRC/secp256k1"
fi
cd "$SRC/secp256k1"
git checkout v0.3.2
./autogen.sh
./configure --enable-module-schnorrsig --enable-experimental
make -j"$(nproc)"
sudo make install

# --- libblst (BLS12-381 builtins; not packaged for Debian/Kali) ---------------
if [ ! -d "$SRC/blst" ]; then
  git clone https://github.com/supranational/blst "$SRC/blst"
fi
cd "$SRC/blst"
git checkout v0.3.11
./build.sh
cat > libblst.pc <<PC
prefix=/usr/local
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: libblst
Description: Multilingual BLS12-381 signature library
URL: https://github.com/supranational/blst
Version: 0.3.11
Cflags: -I\${includedir}
Libs: -L\${libdir} -lblst
PC
sudo cp libblst.pc /usr/local/lib/pkgconfig/
sudo cp bindings/blst_aux.h bindings/blst.h bindings/blst.hpp /usr/local/include/
sudo cp libblst.a /usr/local/lib
sudo chmod u=rw,go=r /usr/local/{lib/{libblst.a,pkgconfig/libblst.pc},include/{blst.{h,hpp},blst_aux.h}}

sudo ldconfig
echo "done: libsodium (IOG), libsecp256k1, libblst installed to /usr/local"
