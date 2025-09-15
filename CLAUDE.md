# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hologram is a pro-grade photo management application built with SvelteKit frontend and Tauri backend. It's designed for photographers who want total control over their files without being forced into bloated editing environments. The application focuses on RAW+JPEG workflows, advanced EXIF-based filtering, and intelligent organization strategies.

## Development Commands

```bash
# Start development server (frontend + Tauri backend)
bun run tauri dev
```

## Architecture

### Tech Stack
- **Frontend**: SvelteKit 5 with TypeScript
- **Backend**: Rust with Tauri 2
- **Styling**: Tailwind CSS 4 with utility components
- **Build Tool**: Vite
- **Package Manager**: Bun

### Project Structure
```
src/
├── routes/           # SvelteKit routes (pages)
├── lib/              # Shared utilities and components
└── app.css          # Global styles

src-tauri/
├── src/
│   ├── main.rs      # Tauri application entry point
│   └── lib.rs       # Rust backend logic and commands
├── Cargo.toml       # Rust dependencies
└── tauri.conf.json  # Tauri configuration
```

### Frontend Architecture
- **SvelteKit 5**: Uses the new runes syntax (`$state`, `$props`, etc.)
- **Static Adapter**: Configured for SPA mode to work with Tauri
- **Tailwind**: Modern utility-first CSS with custom component patterns
- **TypeScript**: Strict typing with utility types for component props

### Backend Architecture
- **Tauri Commands**: Rust functions exposed to frontend via `#[tauri::command]`
- **Plugins**: Currently uses `tauri-plugin-opener` for system integration
- **Build System**: Uses `tauri-build` for compilation

### Key Patterns
- **Component Utilities**: Common utility functions in `src/lib/utils.ts` including `cn()` for class merging
- **Type Safety**: TypeScript utilities for component prop handling without children
- **Tauri Integration**: Frontend communicates with Rust backend through `invoke()` calls

## Development Notes

### File Processing (Planned Features)

The application is designed to handle:
- RAW formats: CR2, CR3, ARW, NEF, DNG
- JPEG processing and RAW+JPEG pairing
- EXIF parsing and metadata extraction
- Local file scanning and organization

### Core Principles

- Never modifies original files
- File-first approach to photo management
- Professional workflow focus
- Local-only processing (no cloud dependencies)

### Component Development
- Follow existing patterns in `src/lib/utils.ts` for utility functions
- Use Tailwind with the `cn()` utility for conditional styling
- Implement TypeScript interfaces for all component props
- Follow SvelteKit 5 conventions with runes syntax

### Tauri Integration
- Add new backend commands in `src-tauri/src/lib.rs`
- Use `#[tauri::command]` annotation for frontend-accessible functions
- Register commands in the `invoke_handler` in the `run()` function
- Frontend calls via `invoke("command_name", { params })`
