cmake_minimum_required(VERSION 3.24)
project(projecto_compress VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
	set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

option(PROJECTO_SANITIZE "Build project code with AddressSanitizer and UBSan (test builds)" OFF)
option(PROJECTO_BUILD_TESTS "Build the doctest suite and register it with ctest" ON)
option(PROJECTO_HARDEN "Hardening flags and static linking for the release binary (GCC/Clang)" ON)

include(CheckCCompilerFlag)
include(CheckCXXCompilerFlag)
include(CheckLinkerFlag)

# Hardened release build: GCC/Clang outside Windows, not in sanitizer builds.
set(PROJECTO_HARDENED OFF)
if(PROJECTO_HARDEN AND NOT PROJECTO_SANITIZE AND NOT MSVC AND NOT WIN32)
	set(PROJECTO_HARDENED ON)
endif()

# Release is -O2 (phase4.md 10.2), for project code and the pinned dependencies alike.
if(NOT MSVC)
	set(CMAKE_C_FLAGS_RELEASE "-O2 -DNDEBUG")
	set(CMAKE_CXX_FLAGS_RELEASE "-O2 -DNDEBUG")
endif()

# The dependencies get the same stack protector and fortify level as project code.
# The flags are added around FetchContent_MakeAvailable only, so project targets
# keep receiving them through projecto_hardening and nothing is passed twice.
set(PROJECTO_SAVED_C_FLAGS "${CMAKE_C_FLAGS}")
if(PROJECTO_HARDENED)
	check_c_compiler_flag(-fstack-protector-strong PROJECTO_C_HAS_STACK_PROTECTOR)
	if(PROJECTO_C_HAS_STACK_PROTECTOR)
		string(APPEND CMAKE_C_FLAGS " -fstack-protector-strong")
	endif()
	if(NOT CMAKE_BUILD_TYPE STREQUAL "Debug")
		string(APPEND CMAKE_C_FLAGS " -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=3")
	endif()
endif()
include(cmake/Dependencies.cmake)
set(CMAKE_C_FLAGS "${PROJECTO_SAVED_C_FLAGS}")

# brotli's default reaction to a failed allocation is exit(1), which would bypass the
# output cleanup and the budget exit code. Make it report the failure instead.
target_compile_definitions(brotlienc PRIVATE BROTLI_ENCODER_CLEANUP_ON_OOM)

# Flags that apply to project code only, never to the pinned dependencies.
add_library(projecto_warnings INTERFACE)
if(MSVC)
	target_compile_options(projecto_warnings INTERFACE /W4 /WX /permissive-)
else()
	target_compile_options(projecto_warnings INTERFACE -Wall -Wextra -Wpedantic -Wshadow -Werror)
endif()

add_library(projecto_sanitizers INTERFACE)
if(PROJECTO_SANITIZE)
	if(MSVC)
		target_compile_options(projecto_sanitizers INTERFACE /fsanitize=address)
	else()
		target_compile_options(projecto_sanitizers INTERFACE
			-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer)
		target_link_options(projecto_sanitizers INTERFACE -fsanitize=address,undefined)
	endif()
endif()

add_library(projecto_hardening INTERFACE)
set(PROJECTO_STATIC_FLAG "")
if(PROJECTO_HARDENED)
	check_cxx_compiler_flag(-fstack-protector-strong PROJECTO_HAS_STACK_PROTECTOR)
	if(PROJECTO_HAS_STACK_PROTECTOR)
		target_compile_options(projecto_hardening INTERFACE -fstack-protector-strong)
	endif()
	target_compile_options(projecto_hardening INTERFACE
		$<$<NOT:$<CONFIG:Debug>>:-U_FORTIFY_SOURCE>
		$<$<NOT:$<CONFIG:Debug>>:-D_FORTIFY_SOURCE=3>)
	if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
		check_linker_flag(CXX "LINKER:-z,relro,-z,now" PROJECTO_HAS_RELRO)
		if(PROJECTO_HAS_RELRO)
			target_link_options(projecto_hardening INTERFACE "LINKER:-z,relro,-z,now")
		endif()
	endif()
	check_linker_flag(CXX -static-pie PROJECTO_HAS_STATIC_PIE)
	check_linker_flag(CXX -static PROJECTO_HAS_STATIC)
	if(PROJECTO_HAS_STATIC_PIE)
		set(PROJECTO_STATIC_FLAG -static-pie)
	elseif(PROJECTO_HAS_STATIC)
		set(PROJECTO_STATIC_FLAG -static)
	elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
		message(FATAL_ERROR "PROJECTO_HARDEN needs a static link on Linux, but neither -static-pie nor -static links "
			"(install the static C and C++ runtime libraries, or configure with -DPROJECTO_HARDEN=OFF)")
	endif()
	message(STATUS "projecto-compress link mode: ${PROJECTO_STATIC_FLAG}")
endif()

add_library(projecto_core STATIC
	src/app.cpp
	src/brotli_codec.cpp
	src/budget_allocator.cpp
	src/cli.cpp
	src/codec_common.cpp
	src/exit_code.cpp
	src/file_io.cpp
	src/paths.cpp
	src/protocol.cpp
	src/version.cpp
	src/zstd_codec.cpp)
target_include_directories(projecto_core PUBLIC include)
# ZSTD_STATIC_LINKING_ONLY (estimates, custom allocator, explicit parameters) is only safe because
# zstd is pinned and linked statically; version.cpp asserts the pin.
target_compile_definitions(projecto_core PUBLIC
	PROJECTO_VERSION="${PROJECT_VERSION}"
	ZSTD_STATIC_LINKING_ONLY)
if(MSVC)
	# fopen is the portable call here; MSVC would otherwise ask for fopen_s.
	target_compile_definitions(projecto_core PUBLIC _CRT_SECURE_NO_WARNINGS)
endif()
target_compile_features(projecto_core PUBLIC cxx_std_20)
target_link_libraries(projecto_core
	PUBLIC libzstd_static brotlienc brotlicommon projecto_sanitizers
	PRIVATE projecto_warnings projecto_hardening)

add_executable(projecto-compress src/main.cpp)
target_link_libraries(projecto-compress PRIVATE projecto_core projecto_warnings projecto_hardening)
if(PROJECTO_STATIC_FLAG)
	target_link_options(projecto-compress PRIVATE ${PROJECTO_STATIC_FLAG})
endif()

if(PROJECTO_BUILD_TESTS)
	enable_testing()
	include("${doctest_SOURCE_DIR}/scripts/cmake/doctest.cmake")

	add_executable(projecto_tests
		tests/cli_tests.cpp
		tests/paths_tests.cpp
		tests/file_io_tests.cpp
		tests/protocol_tests.cpp
		tests/app_tests.cpp
		tests/allocator_tests.cpp
		tests/zstd_plan_tests.cpp
		tests/roundtrip_tests.cpp
		tests/test_support.cpp)
	# The decoders (libzstd's decompression side and brotlidec) are linked into the tests only;
	# projecto-compress never references them, so the static link leaves them out.
	target_link_libraries(projecto_tests PRIVATE projecto_core brotlidec projecto_warnings doctest::doctest)
	# Tests that need minutes at level 22 run only with PROJECTO_LARGE_TESTS=1 and report SKIPPED otherwise.
	doctest_discover_tests(projecto_tests
		PROPERTIES SKIP_REGULAR_EXPRESSION "PROJECTO_LARGE_TESTS is not set")

	add_test(NAME projecto_compress_version COMMAND projecto-compress --version)
	set_tests_properties(projecto_compress_version PROPERTIES
		PASS_REGULAR_EXPRESSION "^\\{\"type\":\"version\",\"version\":\"1\\.0\\.0\",\"zstd\":\"1\\.5\\.7\",\"brotli\":\"1\\.2\\.1\"\\}")
	# PASS_REGULAR_EXPRESSION replaces the exit code check, so the exit code gets its own test.
	add_test(NAME projecto_compress_version_exit_code COMMAND projecto-compress --version)

	# Closed stdout pipe and unwritable output, which need a real process: POSIX shells only.
	if(UNIX)
		find_program(PROJECTO_POSIX_SH sh)
		if(PROJECTO_POSIX_SH)
			add_test(NAME projecto_compress_posix_failures
				COMMAND "${PROJECTO_POSIX_SH}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/posix_failure_tests.sh"
					$<TARGET_FILE:projecto-compress>)
		endif()
	endif()
endif()
