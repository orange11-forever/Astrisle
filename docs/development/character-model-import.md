# Character model import

The desktop settings page accepts GLB, self-contained glTF 2, 3MF, STL, OBJ and FBX.
The bundled blue-haired character is unchanged until a user successfully imports a replacement.

## Import transaction

1. The trusted desktop IPC caller opens the native file picker. Main reads the selected source once and packages referenced companions.
2. Main sends those exact bytes to a dedicated hidden, sandboxed renderer that loads a bundled local parser page. It uses the same Three.js addon loaders as the scene cache, waits for images and validates finite vertices, dimensions, mesh count, triangle count and animations. Unsupported FBX/3MF warning and error diagnostics become visible failures instead of silent appearance changes. The validator has no Node integration, filesystem bridge, network, navigation or popup capability. Its private IPC routes require the validator's own webContents, main frame and exact local page URL. A separate ephemeral session, thirty-second timeout and maximum three admitted validation requests bound its lifecycle; the window, active bytes, request handler and session storage are cleaned after success, failure or crash.
3. Only successful main-owned inspection creates a temporary token bound to both the character and inspected bytes/result for ten minutes. At most one token per character is retained. The settings page can independently inspect the bytes for presentation, but renderer-supplied metadata cannot authorize registration or change the counts: completion uses only the stored main-owned result. The existing atomic profile transaction commits the token once, stores the SHA-256-addressed private copy, increments its revision and resets orientation. Failed or cancelled inspection retains the previous profile. No source file is modified.

Legacy `importCharacter` remains available for existing GLB callers. New settings use the prepare/complete/cancel APIs, so their GLB replacements also receive actual browser parsing before registration. Staged bytes and resource paths never grant arbitrary filesystem access through renderer IPC.

## Format behavior

| Format       | Preserved data                                                                                                                         | Limits                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GLB / glTF 2 | Geometry, supported materials, embedded textures, skins and animation clips                                                            | Existing extension allowlist; no Draco, Meshopt or KTX2; glTF resources must remain embedded                                                     |
| OBJ          | Geometry, UVs, normals, vertex colors and supported MTL materials/textures                                                             | One material library path per `mtllib` line; companion files must be in the selected source folder or its descendants; no bones or animation     |
| FBX          | Three.js-supported geometry, Phong/Lambert materials, embedded or companion PNG/JPEG/WebP/AVIF/BMP textures, skins and animation clips | ASCII FBX 7+, binary FBX 6.4–7.7; unsupported loader data is rejected visibly; no custom shader conversion or external decoders                  |
| STL          | ASCII/binary triangle geometry and supported binary vertex color                                                                       | Usually no material, texture, skin or animation; a neutral material is supplied                                                                  |
| 3MF          | Mesh/component instances, base materials, supported color/texture/PBR properties                                                       | Z-up is converted to Y-up; no skin or animation; unsupported required extensions, composites, multi-properties, lattices and slices are rejected |

Static models retain the existing automatic movement and inferred gait behavior. Skins and animations retain independent skeleton state, while instances of the same asset share GPU geometry/material/texture resources. Inspection templates are disposed; successful FBX-generated blob URLs are revoked after decoding.

## Resource and size boundaries

Source plus external companions must fit within 100 MiB, with at most 256 files. Private multi-file copies are a versioned JSON envelope with base64 payloads, so stored size can be about one third larger; profile `byteLength` is the integrity-checked stored size. Assets are private local state, separate from project artifacts and `.astrisle-dev` source data.

Relative companion paths reject traversal, absolute paths, remote/file URLs and encoded escapes. Main resolves real paths to reject symlink/junction escapes. OBJ material/texture resources must exist. FBX references to obsolete absolute exporter paths are never read: embedded resources can still work, while a required missing external image fails during inspection. Ambiguous FBX basenames are not guessed. Resource URL modification permits only packaged image data and loader-generated blobs, preventing network fallback.

3MF archive entries and declared decompressed bytes are bounded before browser parsing (100 MiB, 512 entries); XML entities and external relationships are rejected. Binary FBX node offsets/depth, property lengths and compressed array output are bounded, and binary STL triangle counts must match file length. Imports require 1–2,000,000 rendered triangles and at most 10,000 scene nodes. These bounds prevent obvious malformed-allocation cases; parsing very large valid files can still briefly occupy the renderer.

## Verification

Tests author tiny independent STL, binary/animated ASCII FBX, textured FBX, OBJ/MTL and zipped 3MF fixtures. Integration coverage verifies durable copies, resource traversal and junction rejection, missing resources, one-use character-bound tokens, malformed FBX/STL allocation declarations and retained profiles. Edge browser coverage runs the actual loaders and image decoder, including namespaced 3MF textures, embedded/companion FBX textures, shared instances and visible decode errors. The settings test exercises staged success followed by a failed replacement without committing the bad model. A real Electron test reproduces and rejects invalid OBJ plus forged positive inspection metadata, verifies independently calculated counts for valid OBJ/3MF/FBX/glTF, rejects private validator IPC from an unrelated webContents, and checks that hidden validation windows are destroyed. Separate real 3MF fixtures verify rejection of data-only implicit functions and console.error-driven partial mesh loss.
