mod commands;
pub mod core;
pub mod error;
mod pty;
mod shellout;
mod state;
mod watcher;

#[cfg(test)]
mod testutil;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_repo,
            commands::git_available,
            commands::list_refs,
            commands::get_graph,
            commands::get_commit,
            commands::get_commit_diff,
            commands::get_worktree_diff,
            commands::get_status,
            commands::stage_paths,
            commands::unstage_paths,
            commands::discard_paths,
            commands::commit,
            commands::create_branch,
            commands::delete_branch,
            commands::rename_branch,
            commands::checkout,
            commands::merge_ref,
            commands::cherry_pick,
            commands::reset_to,
            commands::rebase_onto,
            commands::revert_commit,
            commands::create_patch,
            commands::create_tag,
            commands::delete_tag,
            commands::get_remote_url,
            commands::list_worktrees,
            commands::create_worktree,
            commands::blame_file,
            commands::file_history,
            commands::file_at_commit,
            commands::stash_save,
            commands::stash_list,
            commands::stash_apply,
            commands::stash_pop,
            commands::stash_drop,
            commands::git_network,
            commands::watch_repo,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
