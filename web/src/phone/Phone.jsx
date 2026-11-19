// Phone: the family's iPhone mock standard (owner 2026-11-19). An iPhone-rendered mock phone — black bezel,
// dynamic island, 9:41 status bar, home indicator, lock-screen gradient — inside the shared FloatingDialog, so
// every mock phone in the family is a floating window: draggable (by the bezel top), resizable from all 8
// edges, and pop-out-able to a real browser window. Descends from AI-DEMO2's ConsentMockPhoneFlow lock screen;
// rebuilt on the labs' dialog standard. Vendored, never edited in a lab. See README.md.
import FloatingDialog from "../floating-dialog/FloatingDialog";
import "./phone.css";

export default function Phone({
  open,
  onClose,
  label = "Phone",
  children,
  storageKey = null,
  singletonKey = null,
  testId = "phone",
  className = "",
  defaultWidth = 340,
  defaultHeight = 660,
  minWidth = 300,
  minHeight = 520,
  ...rest
}) {
  return (
    <FloatingDialog
      isOpen={open}
      onClose={onClose}
      title={label}
      ariaLabel={label}
      className={`phone-dialog${className ? ` ${className}` : ""}`}
      storageKey={storageKey}
      singletonKey={singletonKey}
      testId={testId}
      noBackdrop
      placement="bottom-right"
      footer={null}
      defaultWidth={defaultWidth}
      defaultHeight={defaultHeight}
      minWidth={minWidth}
      minHeight={minHeight}
      {...rest}
    >
      <div className="phone-screen" data-testid={`${testId}-screen`}>
        <div className="phone-screen__status" aria-hidden="true">
          <span className="phone-screen__time">9:41</span>
          <span className="phone-screen__island" />
          <span className="phone-screen__glyphs" />
        </div>
        <div className="phone-screen__body">{children}</div>
        <div className="phone-screen__home" aria-hidden="true" />
      </div>
    </FloatingDialog>
  );
}
