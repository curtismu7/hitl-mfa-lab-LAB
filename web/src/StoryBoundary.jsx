import React from "react";

// If the Story chunk cannot load (the lab was rebuilt, a stale file name, the network) the shell bar must survive: Demo mode is never taken down by Story.
export class StoryBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="story-bar" role="alert" data-testid="story-error">
        <span className="story-msg">Story could not load. Reload the page and try again.</span>
        {/* ui-pattern: allow P9 Story error-fallback chrome: the Exit button is the only escape from a failed Story, never a page primary (shared/story run, owner 2026-11-24) */}
        <button type="button" onClick={this.props.onExit}>Exit</button>
      </div>
    );
  }
}
