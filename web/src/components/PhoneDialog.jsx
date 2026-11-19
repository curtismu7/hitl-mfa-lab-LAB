// PhoneDialog: the standard mock-phone window for standalone apps (2026-11-19). The phone is not a nested div in
// another modal: it is its own small FloatingDialog — draggable by the title bar, 8-direction resizable, pop-out to a
// real browser window (the phone stays live), keyboard move, saved position per singletonKey. iPhone chrome (notch,
// status bar, dark frame) comes from the app's `.phone` CSS; children fill the screen. AI-DEMO2 uses the same shapes
// (CibaApprovalPage phone, DraggableModal); this is the standalone standard that folds both together.
import FloatingDialog from "../floating-dialog/FloatingDialog";

export default function PhoneDialog({
  isOpen,
  onClose,
  title = "Phone",
  testId,
  children,
  footer = null,
  singletonKey,
}) {
  return (
    <FloatingDialog
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      testId={testId}
      className="phone-dialog"
      defaultWidth={320}
      defaultHeight={560}
      defaultX={null}
      defaultY={null}
      placement="bottom-right"
      minWidth={260}
      minHeight={420}
      noBackdrop
      singletonKey={singletonKey}
      closeLabel="Close"
      footer={footer}
    >
      <div className="phone phone--window" data-testid={testId ? `${testId}-phone` : undefined}>
        {children}
      </div>
    </FloatingDialog>
  );
}
