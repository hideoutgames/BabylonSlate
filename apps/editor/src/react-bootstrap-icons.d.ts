// react-bootstrap-icons types only its root module; this types the per-icon
// files the editor imports one by one, so only those marks ship.
declare module "react-bootstrap-icons/dist/icons/*" {
  import type { Icon } from "react-bootstrap-icons";
  const icon: Icon;
  export default icon;
}
