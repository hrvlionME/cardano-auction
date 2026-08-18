# Wraps cabal with the env this project needs:
#   - ghcup toolchain on PATH
#   - /usr/local for the hand-built libsodium / secp256k1 / blst
SHELL := /bin/bash
export PATH := $(HOME)/.ghcup/bin:$(PATH)
export PKG_CONFIG_PATH := /usr/local/lib/pkgconfig:$(PKG_CONFIG_PATH)
export LD_LIBRARY_PATH := /usr/local/lib:$(LD_LIBRARY_PATH)
export GHCUP_SKIP_UPDATE_CHECK := 1

.PHONY: build test repl blueprint clean env

build:          ## compile the validator library
	cabal build all

test:           ## run the test suite (2 exploit tests are EXPECTED to fail)
	cabal test --test-show-details=direct

repl:           ## poke at the validator interactively
	cabal repl plinth-auction

blueprint:      ## emit plutus.json (CIP-57) with the compiled script
	cabal run gen-blueprint -- plutus.json

clean:
	cabal clean

env:            ## show what the toolchain resolves to
	@echo "ghc:    $$(which ghc)    $$(ghc --numeric-version)"
	@echo "cabal:  $$(which cabal)  $$(cabal --numeric-version)"
	@pkg-config --modversion libsodium libsecp256k1 libblst
