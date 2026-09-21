cmake_minimum_required(VERSION 3.20)
project(pfx_helper VERSION 1.0.0 LANGUAGES CXX OBJCXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "Build for Apple Silicon")
set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0" CACHE STRING "Minimum macOS version")

# ── Dependencies (Homebrew) ───────────────────────────────────────────────────

set(HOMEBREW_PREFIX "/opt/homebrew" CACHE PATH "Homebrew prefix")

# asdcplib
find_path(ASDCP_INCLUDE_DIR AS_02.h
    PATHS ${HOMEBREW_PREFIX}/include
          ${HOMEBREW_PREFIX}/include/asdcplib
          /usr/local/include
    REQUIRED)
find_library(ASDCP_LIB asdcp
    PATHS ${HOMEBREW_PREFIX}/lib /usr/local/lib REQUIRED)
find_library(KMZ_LIB kumu
    PATHS ${HOMEBREW_PREFIX}/lib /usr/local/lib REQUIRED)

# OpenJPEG
find_package(OpenJPEG QUIET)
if(NOT OpenJPEG_FOUND)
    find_path(OPJ_INCLUDE_DIR openjpeg.h
        PATHS ${HOMEBREW_PREFIX}/include/openjpeg-2.5
              ${HOMEBREW_PREFIX}/include/openjpeg-2.4
              ${HOMEBREW_PREFIX}/include
              /usr/local/include
        REQUIRED)
    find_library(OPJ_LIB openjp2
        PATHS ${HOMEBREW_PREFIX}/lib /usr/local/lib REQUIRED)
else()
    set(OPJ_INCLUDE_DIR ${OpenJPEG_INCLUDE_DIRS})
    # The imported-target name varies by install. Homebrew's OpenJPEG config
    # exports "openjp2"; some distros export "OpenJPEG::OpenJPEG". Fall back to
    # the raw library variable if neither target exists.
    if(TARGET openjp2)
        set(OPJ_LIB openjp2)
    elseif(TARGET OpenJPEG::OpenJPEG)
        set(OPJ_LIB OpenJPEG::OpenJPEG)
    else()
        set(OPJ_LIB ${OPENJPEG_LIBRARIES})
    endif()
endif()

# libplacebo (optional — HDR/DV rendering via Metal)
find_library(PLACEBO_LIB placebo
    PATHS ${HOMEBREW_PREFIX}/lib /usr/local/lib)
find_path(PLACEBO_INCLUDE_DIR libplacebo/renderer.h
    PATHS ${HOMEBREW_PREFIX}/include /usr/local/include)
if(PLACEBO_LIB AND PLACEBO_INCLUDE_DIR)
    set(HAVE_LIBPLACEBO TRUE)
    add_compile_definitions(HAVE_LIBPLACEBO=1)
    message(STATUS "libplacebo found: ${PLACEBO_LIB}")
else()
    set(HAVE_LIBPLACEBO FALSE)
    message(STATUS "libplacebo not found — HDR rendering via libplacebo disabled")
endif()

# ── Sources ───────────────────────────────────────────────────────────────────

set(SOURCES
    main.cpp
    mxf_demux.cpp
    j2k_decode.cpp
    hdr_render.cpp
)

add_executable(pfx_helper ${SOURCES})

target_include_directories(pfx_helper PRIVATE
    ${ASDCP_INCLUDE_DIR}
    ${OPJ_INCLUDE_DIR}
)

target_link_libraries(pfx_helper PRIVATE
    ${ASDCP_LIB}
    ${KMZ_LIB}
    ${OPJ_LIB}
)

if(HAVE_LIBPLACEBO)
    target_include_directories(pfx_helper PRIVATE ${PLACEBO_INCLUDE_DIR})
    target_link_libraries(pfx_helper PRIVATE ${PLACEBO_LIB})
endif()

# macOS frameworks needed for Metal rendering
target_link_libraries(pfx_helper PRIVATE
    "-framework Foundation"
    "-framework Metal"
    "-framework CoreVideo"
    "-framework CoreImage"
    "-framework Cocoa"
)

# ── Install ───────────────────────────────────────────────────────────────────

install(TARGETS pfx_helper
    RUNTIME DESTINATION ${CMAKE_INSTALL_PREFIX}/bin)

# ── Post-build: copy binary to electron/native/ ───────────────────────────────

add_custom_command(TARGET pfx_helper POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        $<TARGET_FILE:pfx_helper>
        ${CMAKE_CURRENT_SOURCE_DIR}/../../native/pfx_helper
    COMMENT "Copying pfx_helper to electron/native/"
)
