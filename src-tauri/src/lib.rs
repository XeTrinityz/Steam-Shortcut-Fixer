use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::collections::HashSet;
use serde::{Deserialize, Serialize};
use regex::Regex;

#[cfg(target_os = "windows")]
use winreg::enums::*;
#[cfg(target_os = "windows")]
use winreg::RegKey;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Game {
    name: String,
    app_id: String,
    path: String,
    status: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ShortcutFix {
    name: String,
    game_id: String,
    icon_url: String,
    location: String,
    success: bool,
    error: Option<String>,
}

fn get_steam_library_folders(steamapps_path: &str) -> Vec<PathBuf> {
    let mut libraries = vec![PathBuf::from(steamapps_path)];
    
    let library_file = Path::new(steamapps_path).join("libraryfolders.vdf");
    
    if let Ok(content) = fs::read_to_string(&library_file) {
        for line in content.lines() {
            if line.contains("\"path\"") {
                if let Some(path) = extract_value(line) {
                    if !path.is_empty() {
                        let library_path = PathBuf::from(path).join("steamapps");
                        if library_path.exists() && library_path != PathBuf::from(steamapps_path) {
                            libraries.push(library_path);
                        }
                    }
                }
            }
        }
    }
    
    libraries
}

fn extract_value(line: &str) -> Option<String> {
    let parts: Vec<&str> = line.split("\"").collect();
    if parts.len() >= 4 {
        Some(parts[3].replace("\\\\", "\\"))
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn find_steam_install_directory() -> Result<PathBuf, String> {
    // Try default location first
    let default_path = PathBuf::from("C:\\Program Files (x86)\\Steam");
    if default_path.join("steam.exe").exists() {
        return Ok(default_path);
    }

    // Try reading from Windows registry
    let hklm = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(steam_key) = hklm.open_subkey("SOFTWARE\\Valve\\Steam") {
        if let Ok(install_path) = steam_key.get_value::<String, _>("SteamPath") {
            let path = PathBuf::from(install_path);
            if path.join("steam.exe").exists() {
                return Ok(path);
            }
        }
    }

    Err("Could not find Steam installation directory".to_string())
}

#[cfg(not(target_os = "windows"))]
fn find_steam_install_directory() -> Result<PathBuf, String> {
    Err("Quick fix only supported on Windows".to_string())
}

fn get_shortcut_locations() -> Vec<PathBuf> {
    let mut locations = Vec::new();

    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        // Regular Desktop
        locations.push(PathBuf::from(&userprofile).join("Desktop"));
        
        // OneDrive Desktop
        locations.push(PathBuf::from(&userprofile).join("OneDrive").join("Desktop"));
        
        // Start Menu
        if let Ok(appdata) = std::env::var("APPDATA") {
            locations.push(PathBuf::from(appdata).join("Microsoft\\Windows\\Start Menu\\Programs"));
        }
    }

    // Filter to only existing directories
    locations.into_iter().filter(|p| p.exists()).collect()
}

#[tauri::command]
fn scan_games(steamapps_path: String) -> Result<Vec<Game>, String> {
    let mut games = Vec::new();
    let mut seen_app_ids = HashSet::new();
    let libraries = get_steam_library_folders(&steamapps_path);
    
    println!("Found {} Steam library folders", libraries.len());
    
    for library_path in libraries {
        println!("Scanning: {:?}", library_path);
        
        let common_path = library_path.join("common");
        
        if !common_path.exists() {
            continue;
        }

        if let Ok(entries) = fs::read_dir(&library_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(filename) = path.file_name() {
                    let filename_str = filename.to_string_lossy();
                    if filename_str.starts_with("appmanifest_") && filename_str.ends_with(".acf") {
                        if let Ok(game) = parse_manifest(&path, &common_path) {
                            if seen_app_ids.insert(game.app_id.clone()) {
                                games.push(game);
                            }
                        }
                    }
                }
            }
        }
    }
    
    println!("Found {} total games", games.len());
    Ok(games)
}

fn parse_manifest(manifest_path: &Path, common_path: &Path) -> Result<Game, String> {
    let content = fs::read_to_string(manifest_path)
        .map_err(|e| format!("Failed to read manifest: {}", e))?;
    
    let mut name = String::new();
    let mut app_id = String::new();
    let mut install_dir = String::new();

    for line in content.lines() {
        if line.contains("\"appid\"") {
            if let Some(val) = extract_value(line) {
                app_id = val;
            }
        } else if line.contains("\"name\"") {
            if let Some(val) = extract_value(line) {
                name = val;
            }
        } else if line.contains("\"installdir\"") {
            if let Some(val) = extract_value(line) {
                install_dir = val;
            }
        }
    }

    let game_path = common_path.join(&install_dir);
    
    if !name.is_empty() && !app_id.is_empty() && game_path.exists() {
        Ok(Game {
            name,
            app_id,
            path: install_dir,
            status: "ready".to_string(),
        })
    } else {
        Err("Invalid manifest data".to_string())
    }
}

#[tauri::command]
fn quick_fix_shortcuts() -> Result<Vec<ShortcutFix>, String> {
    let mut fixes = Vec::new();
    
    // Find Steam installation
    let steam_path = find_steam_install_directory()?;
    let icons_cache = steam_path.join("steam").join("games");
    
    println!("Steam path: {:?}", steam_path);
    println!("Icons cache: {:?}", icons_cache);

    // Create icons cache directory if it doesn't exist
    if !icons_cache.exists() {
        fs::create_dir_all(&icons_cache)
            .map_err(|e| format!("Failed to create icons cache directory: {}", e))?;
    }

    // Get all shortcut locations
    let locations = get_shortcut_locations();
    println!("Scanning {} locations", locations.len());

    for location in locations {
        println!("Scanning: {:?}", location);
        
        // Find all .url files recursively
        if let Ok(entries) = fs::read_dir(&location) {
            for entry in entries.flatten() {
                let path = entry.path();
                
                if path.is_file() && path.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("url")).unwrap_or(false) {
                    let location_name = location.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("Unknown");
                    
                    match process_shortcut(&path, &icons_cache, location_name) {
                        Ok(fix) => {
                            println!("Fixed: {}", fix.name);
                            fixes.push(fix);
                        }
                        Err(e) => {
                            println!("Failed {}: {}", path.display(), e);
                            fixes.push(ShortcutFix {
                                name: path.file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or("Unknown")
                                    .to_string(),
                                game_id: String::new(),
                                icon_url: String::new(),
                                location: location_name.to_string(),
                                success: false,
                                error: Some(e),
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(fixes)
}

fn process_shortcut(file_path: &Path, icons_cache: &Path, location: &str) -> Result<ShortcutFix, String> {
    let content = fs::read_to_string(file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // Extract game ID
    let game_id_regex = Regex::new(r"URL=steam://rungameid/(\d+)")
        .map_err(|_| "Regex error".to_string())?;
    let game_id = game_id_regex
        .captures(&content)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or("Not a Steam game shortcut")?;

    // Extract icon file line to get the icon hash
    let icon_line_regex = Regex::new(r"IconFile=(.+\.ico)")
        .map_err(|_| "Regex error".to_string())?;
    let icon_file_path = icon_line_regex
        .captures(&content)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
        .ok_or("No icon path found")?;

    // Extract icon filename (just the filename, not full path)
    let icon_filename = PathBuf::from(&icon_file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .ok_or("Could not extract icon filename")?;

    // Extract client icon hash from filename
    let hash_regex = Regex::new(r"([a-f0-9]+)\.ico")
        .map_err(|_| "Regex error".to_string())?;
    let client_icon = hash_regex
        .captures(&icon_filename)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or("Could not extract icon hash")?;

    // Construct CDN URL
    let icon_url = format!(
        "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/{}/{}.ico",
        game_id, client_icon
    );

    // Download to central cache
    let cache_icon_path = icons_cache.join(&icon_filename);
    
    // Only download if not already cached
    if !cache_icon_path.exists() {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;

        let response = client
            .get(&icon_url)
            .send()
            .map_err(|e| format!("Download failed: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("HTTP error: {}", response.status()));
        }

        let bytes = response
            .bytes()
            .map_err(|e| format!("Failed to read response: {}", e))?;

        fs::write(&cache_icon_path, bytes)
            .map_err(|e| format!("Failed to write icon: {}", e))?;
    }

    Ok(ShortcutFix {
        name: file_path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string(),
        game_id,
        icon_url,
        location: location.to_string(),
        success: true,
        error: None,
    })
}

#[tauri::command]
fn rename_game_folder(steamapps_path: String, game_path: String) -> Result<String, String> {
    let libraries = get_steam_library_folders(&steamapps_path);
    
    for library in libraries {
        let common_path = library.join("common");
        let original = common_path.join(&game_path);
        
        if original.exists() {
            let temp = common_path.join(format!("{}_temp_rename", game_path));
            fs::rename(&original, &temp)
                .map_err(|e| format!("Failed to rename folder: {}", e))?;
            return Ok(format!("{}_temp_rename", game_path));
        }
    }
    
    Err("Game folder not found in any library".to_string())
}

#[tauri::command]
fn revert_game_folder(steamapps_path: String, temp_name: String) -> Result<(), String> {
    let libraries = get_steam_library_folders(&steamapps_path);
    
    for library in libraries {
        let common_path = library.join("common");
        let temp = common_path.join(&temp_name);
        
        if temp.exists() {
            let original = common_path.join(temp_name.trim_end_matches("_temp_rename"));
            fs::rename(&temp, &original)
                .map_err(|e| format!("Failed to revert folder: {}", e))?;
            return Ok(());
        }
    }
    
    Err("Temp folder not found in any library".to_string())
}

#[tauri::command]
fn open_steam_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("Failed to open Steam: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open Steam: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open Steam: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
fn cleanup_temp_folders(steamapps_path: String) -> Result<Vec<String>, String> {
    let mut cleaned = Vec::new();
    let libraries = get_steam_library_folders(&steamapps_path);

    for library in libraries {
        let common_path = library.join("common");
        
        if let Ok(entries) = fs::read_dir(&common_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(name) = path.file_name() {
                    let name_str = name.to_string_lossy();
                    if name_str.ends_with("_temp_rename") {
                        let original_name = name_str.trim_end_matches("_temp_rename");
                        let original_path = common_path.join(original_name);
                        
                        if fs::rename(&path, &original_path).is_ok() {
                            cleaned.push(original_name.to_string());
                        }
                    }
                }
            }
        }
    }

    Ok(cleaned)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_games,
            rename_game_folder,
            revert_game_folder,
            open_steam_url,
            cleanup_temp_folders,
            quick_fix_shortcuts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

