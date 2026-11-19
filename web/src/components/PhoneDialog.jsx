// PhoneDialog: the hitl lab's name for the shared Phone standard (web/src/phone, vendored byte for byte from
// AI-DEMO-Standalone shared/phone). Kept as a thin alias so PolicyGate call sites keep their isOpen/title/testId
// props. The shared component renders the iPhone chrome (bezel, dynamic island, 9:41 status bar, home indicator)
// inside the FloatingDialog: draggable, 8-way resizable, pop-out-able. All screen text is --on-box on the dark
// wallpaper. See shared/phone/README.md.
import Phone from "../phone/Phone.jsx";

export default function PhoneDialog({ isOpen, onClose, title = "Phone", testId, children, footer = null, singletonKey }) {
  return (
    <Phone open={isOpen} onClose={onClose} label={title} testId={testId ? `${testId}-phone` : undefined} singletonKey={singletonKey}>
      {children}
    </Phone>
  );
}
