# :camera: Hologram

> [!NOTE]
> Hologram is currently in active development. Consider it not ready for use

**Hologram** is a pro-grade photo management application tailored for photographers who want total control over their files without being forced into bloated editing environments. Designed from the ground up to handle RAW+JPEG workflows, advanced EXIF-based filtering, and intelligent organization strategies, Hologram empowers users to manage and analyze their photography with precision.

No cloud lock-in. No black-box automations. Just clean, local photo organization.
Easy filtering for duplicates. Easily select for editing. Easily learn from your past photos.

Eventually I plan to expand it to normies, directly competing with Google Photos.

## Roadmap

### MVP
- [X] Local file scanning and ingestion
- [X] Support for standard file formats (~~CR2, CR3, ARW, NEF, DNG~~, JPEG)
- [ ] Folder watching & structured import by date/camera
- [X] EXIF parsing and display
- [ ] Basic filtering by camera model, lens, exposure mode, aperture, etc. ⁉️ - kind of broken honestly
- [ ] RAW+JPEG pairing
- [ ] Unified view of RAW+JPEG sets
- [ ] Quick toggle between in-camera JPEG and RAW previews
- [ ] LUT/Preview Comparison
- [ ] Load LUTs and compare to in-camera JPEG render
- [ ] Render previews (via embedded thumbnails or Apple’s preview engine)
- [X] Lightweight UI[^1]
- [ ] Grid view, timeline, EXIF sidebar, diff mode

[^1]: if you can call what we have right now "lightweight"
### Milestone 2
- [ ] Smart collections
- [ ] Saved searches like “Manual vs Av Priority,” “High ISO,” or “Telephoto shots”
- [ ] Custom tagging & notes
- [ ] Add tags/comments to individual photos or sets
- [ ] Performance improvements
- [ ] Thumbnail caching, progressive loading, faster file parsing
- [ ] Export/Sharing tools
- [ ] Export filtered sets to folders, zip, or Lightroom

### Long-Term
- [ ] Plugin system
- [ ] Scriptable import/export or EXIF rules
- [ ] Semantic search (experimental)
- [ ] Detect visual content (e.g. “sunset with shallow DOF”) with ML
- [ ] Versioned storage
- [ ] Keep alternate versions of RAWs (e.g. LUT A, LUT B, In-Camera)
- [ ] Mobile viewer/companion app
- [ ] View and filter photos from desktop library on mobile
- [ ] Server side hosting and sync?

## Long Description

Hologram is for photographers who want clarity and control—who shoot in full manual, wrestle with dynamic range, and compare in-camera JPEGs to flat RAWs with clinical curiosity. Built for those who reject the Apple Photos “let the algorithm do it” model (and also want easy access to their RAWs), Hologram provides a professional file-first view of your work.

Organize by folder, EXIF, camera, or custom rules. Compare your technique over time. Track when you nailed a shot manually versus let the camera decide. Pair JPEG previews with RAW originals and see how your vision evolved.

And most importantly: it never touches your files. Never. It's not an editing program and it never will be.

<!-- ## Next Steps (For Kickoff Next Weekend)

Prep (Before the Weekend)
- Define core file structure conventions (RAW+JPEG pair logic, import heuristics)
- Pick tech stack (Electron + Tauri + Rust backend? Or just local web app?)
- Sketch rough UI: sidebar, main grid, EXIF inspector
- Set up GitHub repo + Notion or Obsidian project space

Build Weekend 1
- Build base import scanner (read folder tree, load metadata)
- Parse EXIF from JPEG and RAW (use exiftool or native lib)
- Create grid view with metadata overlay
- Implement RAW+JPEG pairing logic -->

## Manifesto

We believe photos are data—rich, nuanced, untampered data.

We believe in ownership, not outsourcing.
We believe in understanding exposure, not just applying filters.
We believe EXIF is not just metadata—it’s the story of how you saw the light.

We reject software that buries photos behind AI guesswork.
We reject platforms that hide your RAWs, blur your edits, or downsample your history.

Hologram is for the ones who care how the shot was made.
Not just how it looks.
