8. **Interactive completion prompt.** After every review pass (all tiers), ask the user what to do next:
   ```
   IF Rating == READY:
     AskUserQuestion(
       question = "Plan is READY — all checks pass. Exit plan mode, or keep editing?",
       options = ["Exit plan mode", "Continue editing"]
     )
   IF Rating == SOLID or GAPS:
     AskUserQuestion(
       question = "Plan has [N] non-blocking issue(s). Exit plan mode anyway, or keep editing?",
       options = ["Exit plan mode (with warnings)", "Continue editing"]
     )
   IF Rating == REWORK:
     AskUserQuestion(
       question = "Gate 1 issues block exit. Describe the changes you want to make, or abandon.",
       options = ["Describe changes", "Abandon review"]
     )

   IF user selected "Exit plan mode" or "Exit plan mode (with warnings)":
     Write gate file: Bash "echo '<plan_path>' > /tmp/.review-ready-${plan_slug}"
     # Gate file written here — after user confirms — so no stale file exists during editing cycles.
     # Do NOT delete the gate file — the ExitPlanMode PostToolUse hook removes it after successful exit.
     ExitPlanMode(allowedPrompts=[{tool:"Bash",prompt:"run tests"},{tool:"Bash",prompt:"run build"},{tool:"Bash",prompt:"run linter"},{tool:"Bash",prompt:"git add and commit"},{tool:"Bash",prompt:"git status"},{tool:"Bash",prompt:"git diff"},{tool:"Bash",prompt:"git push to remote"}])

   IF user chooses to continue editing (or is in REWORK and describes changes):
     Apply the user's requested changes to the plan file.
     Re-run review from Step 0 item 3 (context-flags classifier) through the full outer flow — re-classify, then branch to TRIVIAL/SMALL/FULL as appropriate. Do not skip re-classification.
     # This loop repeats until user confirms exit or abandons. No hard cap — user controls termination.

   IF user chooses "Abandon review" (REWORK only):
     Print: "Review abandoned. Plan is unchanged and still has Gate 1 issues."
     Print: "You remain in plan mode — make changes and run /review-plan again when ready."
     STOP  # ExitPlanMode is NOT called — user stays in plan mode to fix or manually exit
   ```

