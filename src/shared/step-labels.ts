/** The plain-words step a teammate is on, by tool. Fixed text written by
 * Sidemates, never by a model or a web page, so it is safe to show anywhere
 * (the job card, and the helper lines while a lead waits). */
export const TOOL_STEP_LABELS: Record<string, string> = {
  workspace_list: "Checking my files", workspace_read: "Reading the file", workspace_write: "Saving your file",
  workspace_replace: "Updating the file", isolated_bash: "Working in my workspace", bash: "Working in my workspace",
  browser_open: "Opening the website", browser_snapshot: "Reading the page", browser_click: "Using the page", browser_request_sign_in: "Waiting for your sign-in",
  browser_type: "Filling in the page", remember: "Remembering this for next time", handoff: "Asking a teammate to help",
  mac_list: "Looking through your Mac files", mac_read: "Reading the Mac file", mac_organize: "Preparing a tidy-up for your approval",
  queue_propose: "Preparing a card for your review", mac_apps_list: "Seeing which Mac apps are open", mac_app_inspect: "Reading the app", mac_app_open: "Opening the app", mac_calendar_events: "Reading your calendar", mac_mail_unread: "Checking your unread mail", search_my_mac: "Searching your files, notes and mail", mac_mail_search: "Searching your Mail", mac_mail_read: "Reading an email", mac_mail_save_attachment: "Preparing to save an attachment for your approval", mac_reminders: "Checking your reminders", mac_reminder_create: "Preparing a reminder for your approval", mac_notes_search: "Searching your notes", mac_note_read: "Reading a note", mac_note_create: "Preparing a note for your approval", mac_contacts_find: "Looking up a contact", mac_calendars: "Checking your calendars", mac_event_create: "Preparing an event for your approval", mac_mail_draft: "Drafting an email in Mail", mac_shortcuts_list: "Checking your shortcuts", mac_shortcut_run: "Preparing a shortcut for your approval",
  mac_app_click: "Preparing a click for your approval", mac_app_type: "Preparing text entry for your approval", mac_app_key: "Preparing a key press for your approval", mac_app_scroll: "Moving through the app",
  gmail_search: "Looking through your inbox", gmail_read: "Reading the email", gmail_send: "Preparing the email for your approval", gmail_reply: "Preparing a reply in the original conversation",
  google_drive_search: "Looking through your Drive", google_drive_read: "Reading the Drive file", google_drive_create: "Preparing a Drive file for your approval", google_calendar_agenda: "Checking your calendar", google_calendar_create: "Preparing a calendar event for your approval",
  github_notifications: "Checking your GitHub updates", github_issues: "Looking through GitHub issues", github_issue_create: "Preparing a GitHub issue for your approval",
  slack_search: "Looking through Slack", slack_read: "Reading the Slack conversation", slack_post: "Preparing a Slack message for your approval",
  notion_search: "Looking through shared Notion pages", notion_read: "Reading the Notion page", notion_update: "Preparing a Notion update for your approval",
  todoist_tasks: "Checking your Todoist tasks", todoist_task_create: "Preparing a Todoist task for your approval", todoist_task_update: "Preparing a Todoist change for your approval", todoist_task_complete: "Preparing a Todoist completion for your approval",
  dropbox_search: "Looking through Dropbox", dropbox_read: "Reading the Dropbox file",
  code_projects: "Checking shared code projects", code_list: "Reading the project structure", code_search: "Searching the code", code_read: "Reading a project file",
  code_write: "Saving a code change", code_replace: "Applying a focused code change", code_status: "Reviewing project changes", code_diff: "Reading the code diff",
  code_branch: "Starting an isolated work branch", code_commit: "Saving a reviewed checkpoint", code_request_review: "Asking for an independent code review", code_review_result: "Recording the independent review", code_publish_pr: "Preparing a pull request for your approval", code_run: "Running project checks",
  work_collect: "Gathering your briefing sources", work_report: "Preparing your source-linked result",
  spreadsheet_export: "Creating your workbook",
  document_export: "Creating your document",
  video_fetch: "Saving the video",
  video_render: "Making your video",
  web_search: "Searching the web", web_read: "Reading the page",
  spreadsheet_inspect: "Checking your saved workbook", conversation_search: "Looking back in this conversation",
  table_summary: "Calculating your table totals",
  task_plan: "Setting the finish line", task_progress: "Moving the job forward", task_verify: "Checking the finished work",
  routine_create: "Setting up your routine", skill_propose: "Preparing a reusable skill for your review",
  message_teammate: "Checking in with a teammate", request_approval: "Checking with you first", self_extend: "Proposing to write its own tool",
};

export const KNOWN_STEP_LABELS = new Set(Object.values(TOOL_STEP_LABELS));
