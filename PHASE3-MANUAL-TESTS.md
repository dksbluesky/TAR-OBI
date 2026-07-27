# Execution Bridge Phase 3 Manual Acceptance Tests

Phase 3 adds optional monitoring context only. It must never alter either application's trading calculations or create a transaction/order.

## 1. Standalone ETF_DCA-plan

- Clear only `etfDca.executionBridge.v1`, or use a browser profile where no bridge exists.
- Open ETF_DCA-plan without starting a bridge.
- Confirm Portfolio, DCA, Direct Buy, Entry Watch, Suggested Zone, Active Zone, H1/H2, C1, C2, C3, and C4 behave as before.
- Confirm the Execution Bridge panel says `Not Started`.
- Confirm no portfolio or GitHub synchronization data changes merely by viewing the panel.

## 2. Standalone TAR-OBI

- Open `entry-assessment.html` with no bridge.
- Confirm Execution Context remains hidden.
- Confirm TAR, OBI, VWAP, spread, volume quality, preferred entry, maximum entry, invalidation, confidence, and Entry Assessment behave as before.
- Confirm TAR-OBI continues its existing refresh interval.
- Confirm no bridge storage object is created.

## 3. Start Linked Monitor

- From ETF_DCA-plan Entry Watch, click `Start TAR-OBI Monitor`.
- On desktop, confirm TAR-OBI opens in a new tab.
- On a mobile/tablet viewport or device, confirm TAR-OBI opens in the same tab.
- Confirm TAR-OBI loads the ticker and read-only Execution Context.
- Confirm lifecycle status is `ACTIVE`.
- Confirm `Back to ETF_DCA-plan` and `Disconnect Bridge` remain available.

## 4. Result Write-Back

- Allow one successful existing TAR-OBI quote refresh.
- Return to ETF_DCA-plan.
- Confirm the assessment state, current price, and evaluated time appear.
- Confirm ETF_DCA-plan H1/H2, C1–C4, Bottom Synthesis, and transaction data do not change.
- Confirm unknown fields in the bridge remain present using browser storage inspection.

## 5. Entry Transition Notification

- In Linked Monitor Mode, click `Enable Notifications`.
- Grant permission if the browser supports it.
- Test or simulate `WAIT FOR CONFIRMATION` → `ENTRY CONDITIONS MET`.
- Confirm one dismissible in-page alert appears.
- When permission is granted, confirm one browser notification appears.
- Allow another refresh with the same state and confirm no duplicate notification.
- Change away from `ENTRY CONDITIONS MET`, return within ten minutes, and confirm cooldown blocks another notification.
- Return after ten minutes and confirm one notification is allowed.

## 6. Sustained Data Unavailable

- Test a valid completed assessment refresh that remains `DATA UNAVAILABLE`.
- Keep that state for at least five minutes.
- Confirm one lower-priority alert appears and is not repeated on each refresh.
- Restore another assessment state and confirm a later separate unavailable episode can be tracked independently.

## 7. Pause and Resume

- Pause from ETF_DCA-plan and confirm TAR-OBI updates to `PAUSED` through the storage event.
- Confirm TAR-OBI calculations and normal refresh continue.
- Confirm bridge result write-back and notifications stop.
- Resume from either application and confirm status becomes `ACTIVE`.
- Confirm the next successful refresh resumes write-back.

## 8. Complete

- Click `End Monitor`.
- Confirm lifecycle becomes `COMPLETED` and completion time is stored.
- Confirm the final result remains visible in ETF_DCA-plan.
- Confirm later TAR-OBI refreshes do not overwrite the final result or notify.
- Click `Start New Monitor` and confirm it creates a different `bridgeId`.

## 9. Expiration

- Use the automated clock fixture or temporarily create a test bridge whose `expiresAt` is in the past.
- Confirm lifecycle becomes `EXPIRED`.
- Confirm both applications display the expired state and reason.
- Confirm later refreshes do not write results.
- Confirm Friday-after-close creation calculates the following Monday at 13:30 Asia/Taipei.
- Note: Taiwan public-market holidays are not handled in Phase 3.

## 10. Source Invalidation

- Start a bridge, then change one source identity field in ETF_DCA-plan: ticker, Active Zone low/high, zone mode, or market-level timeframe.
- Confirm the old bridge becomes `INVALIDATED` with a reason.
- Confirm price changes and C1–C4 recalculation alone do not invalidate it.
- Confirm a new monitor can be started with a new `bridgeId`.

## 11. One Active Bridge and Cross-Tab Sync

- Keep ETF_DCA-plan and TAR-OBI open in separate tabs.
- Confirm result/lifecycle changes refresh the other tab's bridge UI without triggering another market-data fetch.
- Attempt to start another ticker while the first bridge is active.
- Confirm a replacement warning appears and cancel it; verify the first bridge remains.
- Confirm replacement only occurs after explicit confirmation.
- Open a second TAR-OBI tab and confirm only the latest active linked session writes/alerts.

## 12. Disconnect and Storage Isolation

- Click `Disconnect Bridge` in TAR-OBI.
- Confirm TAR-OBI returns to Standalone Mode without completing or deleting the bridge.
- Confirm ETF_DCA-plan can still display the bridge.
- Confirm portfolio storage, Fugle credentials, TAR-OBI assessment settings, and unrelated local storage keys are unchanged.
- Place malformed JSON in the bridge key and confirm both applications continue safely in standalone mode.

## 13. Portable-Device Limitation

- Confirm the Linked Monitor panel displays: `Monitoring requires this page to remain open. Mobile operating systems may suspend background pages.`
- Confirm no claim is made that GitHub Pages can monitor after the browser closes or the operating system terminates/suspends the tab.
