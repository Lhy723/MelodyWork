#[path = "workspace_files.rs"]
mod workspace_files;
#[path = "workspace_terminal.rs"]
mod workspace_terminal;

#[allow(unused_imports)]
pub use workspace_files::{
    WorkspaceEntry, pick_workspace_directory, read_workspace_binary_file, read_workspace_file,
    workspace_tree, write_workspace_file,
};
pub use workspace_terminal::{
    TerminalRuntime, close_terminal_session, create_terminal_session, resize_terminal_session,
    write_terminal_input,
};

#[cfg(test)]
pub(crate) use workspace_files::collect_tree;
#[cfg(test)]
pub(crate) use workspace_files::is_ignored_directory;
#[cfg(test)]
pub(crate) use workspace_files::read_workspace_binary_bytes;
#[cfg(test)]
pub(crate) use workspace_files::safe_write_path;
#[cfg(test)]
pub(crate) use workspace_terminal::{terminal_command, wait_for_terminal_exit};

#[cfg(test)]
#[path = "workspace_runtime_tests.rs"]
mod tests;
