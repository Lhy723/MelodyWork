use super::*;
use std::fs;
use std::process::Command;

fn create_untracked_repo() -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("melody-git-review-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create temporary git repository");
    let status = Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(&root)
        .status()
        .expect("start git init");
    assert!(status.success(), "git init should succeed");
    fs::write(root.join("notes.txt"), "first line\nsecond line\n").expect("write untracked file");
    root
}

#[test]
fn parses_numstat_and_ignores_binary_counts() {
    let parsed = parse_numstat("4\t2\tsrc/app.ts\n-\t-\timage.png\n");
    assert_eq!(parsed.get("src/app.ts"), Some(&(4, 2)));
    assert_eq!(parsed.get("image.png"), Some(&(0, 0)));
}

#[test]
fn parses_porcelain_worktrees() {
    let worktrees = parse_worktrees(
        "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n\
         worktree /repo-feature\nHEAD def\nbranch refs/heads/feature\n\n",
    );
    assert_eq!(worktrees.len(), 2);
    assert_eq!(worktrees[1].branch.as_deref(), Some("feature"));
}

#[tokio::test]
async fn includes_untracked_text_files_in_review_stats_and_diff() {
    let root = create_untracked_repo();
    let root_string = root.to_string_lossy().into_owned();

    let changes = git_changes_at(Path::new(&root_string))
        .await
        .expect("read git changes");
    let change = changes
        .iter()
        .find(|change| change.path == "notes.txt")
        .expect("untracked file should be listed");
    assert_eq!(change.status, "??");
    assert_eq!(change.additions, 2);
    assert_eq!(change.deletions, 0);

    let diff = git_diff_at(Path::new(&root_string), "notes.txt")
        .await
        .expect("read untracked file diff");
    assert!(!diff.binary);
    assert!(diff.content.contains("new file mode"));
    assert!(diff.content.contains("+first line"));
    assert!(diff.content.contains("+second line"));

    fs::remove_dir_all(root).expect("remove temporary git repository");
}

#[tokio::test]
async fn preserves_unicode_and_space_paths_from_porcelain_status() {
    let root = create_untracked_repo();
    let path = "中文 notes.txt";
    fs::write(root.join(path), "first line\n").expect("unicode fixture should be written");

    let changes = git_changes_at(&root).await.expect("read git changes");

    assert!(
        changes.iter().any(|change| change.path == path),
        "git status should return the original path, got: {changes:?}"
    );

    fs::remove_dir_all(root).expect("remove temporary git repository");
}

fn create_committed_repo() -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("melody-git-branches-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create temporary git repository");
    let run = |args: &[&str]| {
        let status = Command::new("git")
            .args(args)
            .current_dir(&root)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} should succeed");
    };
    run(&["init", "--quiet", "-b", "main"]);
    fs::write(root.join("notes.txt"), "one\n").expect("write committed file");
    run(&["add", "notes.txt"]);
    run(&[
        "-c",
        "user.name=qa",
        "-c",
        "user.email=qa@example.com",
        "commit",
        "--quiet",
        "-m",
        "init",
    ]);
    root
}

#[tokio::test]
async fn rejects_invalid_branch_names_with_product_copy() {
    let root = create_committed_repo();

    let error = create_branch_at(&root, "bad name")
        .await
        .expect_err("invalid branch name should be rejected");

    assert!(error.contains("分支名"), "unexpected message: {error}");
    assert!(!error.contains("fatal:"), "raw git error leaked: {error}");

    fs::remove_dir_all(root).expect("remove temporary git repository");
}

#[tokio::test]
async fn rejects_branch_names_that_look_like_options() {
    let root = create_committed_repo();

    let error = checkout_branch_at(&root, "-f")
        .await
        .expect_err("option-like branch name should be rejected");

    assert!(error.contains("分支名"), "unexpected message: {error}");

    fs::remove_dir_all(root).expect("remove temporary git repository");
}

#[tokio::test]
async fn checkout_switches_head_to_an_existing_branch() {
    let root = create_committed_repo();
    create_branch_at(&root, "feature-check")
        .await
        .expect("create branch");

    checkout_branch_at(&root, "main")
        .await
        .expect("checkout main");

    let head = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&root)
        .output()
        .expect("read HEAD");
    assert!(head.status.success(), "git rev-parse should succeed");
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "main");

    fs::remove_dir_all(root).expect("remove temporary git repository");
}

#[tokio::test]
async fn checkout_missing_branch_returns_not_found_copy() {
    let root = create_committed_repo();

    let error = checkout_branch_at(&root, "missing-branch")
        .await
        .expect_err("missing branch should be rejected");

    assert!(error.contains("不存在"), "unexpected message: {error}");
    assert!(
        error.contains("missing-branch"),
        "unexpected message: {error}"
    );

    fs::remove_dir_all(root).expect("remove temporary git repository");
}
