import Foundation

// Pure checks for how a web control's role reaches the model (Reveal.swift):
// the role word in context.controls, and the roles whose value is what the
// user set and so never names the control. Market shard 3/3 at c8c9e10
// (cycle 20260920-0415): a smart-home page's thermostat, an <input
// type=number> that Chrome and Safari expose as an AXIncrementor, was never
// listed, so the model clicked it by coordinates into TARGET_UNIDENTIFIED
// four times and the run handed off.
func controlRoleChecks(_ check: (Bool, String) -> Void) {
    check(controlRoleWord(role: "AXIncrementor") == "number",
          "an AXIncrementor is listed as a number input: the model reads role words, and incrementor names nothing it knows")
    check(controlRoleWord(role: "AXSlider") == "slider" && controlRoleWord(role: "AXTextField") == "textfield"
          && controlRoleWord(role: "AXRadioButton") == "radiobutton" && controlRoleWord(role: "AXButton") == "button" && controlRoleWord(role: "AXLink") == "link",
          "every other role is its own name without the AX prefix, lowercased")
    check(controlRoleWord(role: "AXTextArea") == "textarea" && controlRoleWord(role: "AXComboBox") == "combobox" && controlRoleWord(role: "AXCheckBox") == "checkbox"
          && controlRoleWord(role: "AXPopUpButton") == "popupbutton" && controlRoleWord(role: "AXMenuButton") == "menubutton" && controlRoleWord(role: "AXTab") == "tab",
          "the words the walk listed before are unchanged")
    check(editableControlRoles == ["AXTextField", "AXTextArea", "AXComboBox", "AXIncrementor", "AXSlider"],
          "a field's text, a number input's value and a slider's position are what the user set, never a name")
    check(!editableControlRoles.contains("AXButton") && !editableControlRoles.contains("AXRadioButton") && !editableControlRoles.contains("AXLink"),
          "a button's, a radio's or a link's value still names it")
}
