/* See license.txt for terms of usage */

define(function(require, exports/*, module*/) {

"use strict";

// Dependencies
const React = require("react");

// Firebug.SDK
const { createFactories } = require("reps/rep-utils");
const { Toolbar, ToolbarButton } = createFactories(require("reps/toolbar"));

// Shortcuts
const { div, button, textarea } = React.DOM;

/**
 * TODO
 */
var EditResendTab = React.createClass({
/** @lends EditResendTab */

  displayName: "EditResendTab",

  getInitialState: function() {
    return { payload: '' };
  },

  componentWillMount() {
    this.payloadPropToState();
  },

  componentWillReceiveProps(newProps) {
    if (newProps.selection && newProps.selection.data.payload !== this.state.payload) {
      this.payloadPropToState();
    }
  },

  payloadPropToState() {
    this.setState({ payload: this.props.selection ? this.props.selection.data.payload : '' });
  },

  handleChange(e) {
    this.setState({ payload: e.target.value });
  },

  handleSend() {
    console.log(this.state.payload);
    console.log(this);
  },

  render: function() {
    var frame = this.props.selection || {};
    var data = frame.data;

    return (
      div({className: 'editResendTabContent'},
        Toolbar({className: "toolbar", ref: "toolbar"},
          ToolbarButton({bsSize: "xsmall", onClick: this.handleSend},
            Locale.$STR("websocketmonitor.Send")
          )
        ),
        textarea({ onChange: this.handleChange, value: this.state.payload })
      )
    );
  }
});

// Exports from this module
exports.EditResendTab = EditResendTab;
});
