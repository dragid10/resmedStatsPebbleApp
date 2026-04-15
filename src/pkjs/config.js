/**
 * Clay configuration page definition for the ResMed Stats app.
 *
 * This config is only shown when the user has NOT yet logged in.
 * Once logged in, a custom "Connected" page is shown instead
 * (see showConfiguration handler in index.js).
 *
 * Fields:
 *   - Email:    myAir account email address
 *   - Password: myAir account password
 *   - Region:   NA (North America) or EU (Europe)
 */
module.exports = [
  {
    "type": "heading",
    "defaultValue": "ResMed myAir Settings"
  },
  {
    "type": "text",
    "defaultValue": "Your credentials are stored locally on your phone only. Nothing is sent to the cloud or stored on any external server."
  },
  {
    "type": "section",
    "items": [
      {
        "type": "heading",
        "defaultValue": "Account"
      },
      {
        "type": "input",
        "messageKey": "Email",
        "label": "Email Address",
        "defaultValue": "",
        "attributes": {
          "placeholder": "your@email.com",
          "type": "email",
          "required": true
        }
      },
      {
        "type": "input",
        "messageKey": "Password",
        "label": "Password",
        "defaultValue": "",
        "attributes": {
          "placeholder": "myAir password",
          "type": "password",
          "required": true
        }
      },
      {
        "type": "select",
        "messageKey": "Region",
        "label": "Region",
        "defaultValue": "NA",
        "options": [
          { "label": "North America", "value": "NA" },
          { "label": "Europe", "value": "EU" }
        ]
      }
    ]
  },
  {
    "type": "submit",
    "defaultValue": "Save & Connect"
  }
];
