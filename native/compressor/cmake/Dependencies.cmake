# Pinned third-party sources. Every URL carries a SHA256 and the git source a full commit id,
# so a changed or tampered download fails the configure step. Bump a pin only through a
# reviewed change that updates the URL, the hash or commit and the matching constants in
# src/version.cpp.
#
#   zstd 1.5.7    zstd-1.5.7.tar.gz.sha256 published with the GitHub release
#   brotli 1.2.1  no source asset or checksum is published, and GitHub's tag archives are not
#                 guaranteed to stay byte-identical, so brotli is cloned with git and checked
#                 out at the full commit id of the v1.2.1 tag (a lightweight tag on
#                 db24a98aed38a16de78cc05ca15cdd8dc2a0d92d). The commit id names the whole tree,
#                 so it cannot change under the pin. Needs git at configure time.
#   doctest 2.5.3 the release asset doctest-v2.5.3.tar.gz, GitHub's published digest
#
# For offline builds point FETCHCONTENT_SOURCE_DIR_ZSTD / _BROTLI / _DOCTEST at unpacked,
# checked trees (for brotli: a checkout of the commit above).

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
set(ZSTD_MULTITHREAD_SUPPORT ON CACHE BOOL "" FORCE)

set(PROJECTO_BROTLI_COMMIT db24a98aed38a16de78cc05ca15cdd8dc2a0d92d)
if(NOT FETCHCONTENT_SOURCE_DIR_BROTLI)
	find_package(Git REQUIRED)
endif()
# A full clone: git cannot shallow-clone a bare commit id. No submodules (brotli has none).
FetchContent_Declare(brotli
	GIT_REPOSITORY https://github.com/google/brotli.git
	GIT_TAG        ${PROJECTO_BROTLI_COMMIT}
	GIT_SHALLOW    FALSE
	GIT_SUBMODULES ""
	GIT_PROGRESS   FALSE
	# Brotli's CMakeLists.txt is not at this subdirectory, so FetchContent_MakeAvailable only
	# downloads. The tree is verified below and add_subdirectory runs after that.
	SOURCE_SUBDIR  projecto-verify-before-adding)
set(BROTLI_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(BROTLI_DISABLE_TESTS ON CACHE BOOL "" FORCE)
set(BROTLI_BUNDLED_MODE ON CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(zstd brotli)

# The clone must sit exactly on the pinned commit with no local changes (a build tree reused
# from an older pin, or an edited _deps checkout, fails here). Brotli's build globs every .c file
# in c/common, c/dec and c/enc, so an untracked or ignored file counts as a local change too
# (--untracked-files=all --ignored=traditional). A FETCHCONTENT_SOURCE_DIR_BROTLI override is the
# caller's responsibility and is not checked.
if(NOT FETCHCONTENT_SOURCE_DIR_BROTLI)
	execute_process(
		COMMAND "${GIT_EXECUTABLE}" -C "${brotli_SOURCE_DIR}" rev-parse --verify "HEAD^{commit}"
		OUTPUT_VARIABLE projecto_brotli_head
		OUTPUT_STRIP_TRAILING_WHITESPACE
		RESULT_VARIABLE projecto_brotli_head_result)
	execute_process(
		COMMAND "${GIT_EXECUTABLE}" -C "${brotli_SOURCE_DIR}" status --porcelain --untracked-files=all --ignored=traditional
		OUTPUT_VARIABLE projecto_brotli_changes
		OUTPUT_STRIP_TRAILING_WHITESPACE
		RESULT_VARIABLE projecto_brotli_status_result)
	if(NOT projecto_brotli_head_result EQUAL 0 OR NOT projecto_brotli_head STREQUAL PROJECTO_BROTLI_COMMIT)
		message(FATAL_ERROR "brotli at ${brotli_SOURCE_DIR} is at '${projecto_brotli_head}', expected "
			"${PROJECTO_BROTLI_COMMIT}. Delete the build directory and configure again.")
	endif()
	if(NOT projecto_brotli_status_result EQUAL 0 OR NOT projecto_brotli_changes STREQUAL "")
		message(FATAL_ERROR "brotli at ${brotli_SOURCE_DIR} has local changes or extra files:\n${projecto_brotli_changes}")
	endif()
endif()
add_subdirectory("${brotli_SOURCE_DIR}" "${brotli_BINARY_DIR}")

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
