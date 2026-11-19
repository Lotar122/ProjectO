# Pinned third-party sources. Every URL carries a SHA256 so a changed or tampered
# download fails the configure step. Bump a pin only through a reviewed change that
# updates the URL, the hash and the matching constants in src/version.cpp.
#
#   zstd 1.5.7    zstd-1.5.7.tar.gz.sha256 published with the GitHub release
#   brotli 1.2.1  no checksum is published; hash of the v1.2.1 tag archive, verified by
#                 diffing the unpacked archive against `git archive` of commit db24a98
#   doctest 2.5.3 the release asset doctest-v2.5.3.tar.gz, GitHub's published digest
#
# For offline builds point FETCHCONTENT_SOURCE_DIR_ZSTD / _BROTLI / _DOCTEST at unpacked,
# hash-checked trees.

include(FetchContent)

set(CMAKE_POLICY_DEFAULT_CMP0077 NEW)

FetchContent_Declare(zstd
	URL      https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz
	URL_HASH SHA256=eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3
	SOURCE_SUBDIR build/cmake
	DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
set(ZSTD_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_CONTRIB OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_STATIC ON CACHE BOOL "" FORCE)
set(ZSTD_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(ZSTD_LEGACY_SUPPORT OFF CACHE BOOL "" FORCE)
set(ZSTD_MULTITHREAD_SUPPORT OFF CACHE BOOL "" FORCE)

FetchContent_Declare(brotli
	URL      https://github.com/google/brotli/archive/refs/tags/v1.2.1.tar.gz
	URL_HASH SHA256=98d35d11a78dc453aebb7d10c3748f3f73ff78c8267c0dc697b8631f67bf7e8f
	DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
set(BROTLI_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(BROTLI_DISABLE_TESTS ON CACHE BOOL "" FORCE)
set(BROTLI_BUNDLED_MODE ON CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(zstd brotli)

if(PROJECTO_BUILD_TESTS)
	FetchContent_Declare(doctest
		URL      https://github.com/doctest/doctest/releases/download/v2.5.3/doctest-v2.5.3.tar.gz
		URL_HASH SHA256=eb4a39729d091e43d4d593888bf4d145ee9a0f0e13f7404484b6f2fb60d5d50f
		DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
	set(DOCTEST_WITH_TESTS OFF CACHE BOOL "" FORCE)
	set(DOCTEST_WITH_MAIN_IN_STATIC_LIB OFF CACHE BOOL "" FORCE)
	set(DOCTEST_NO_INSTALL ON CACHE BOOL "" FORCE)
	FetchContent_MakeAvailable(doctest)
endif()
