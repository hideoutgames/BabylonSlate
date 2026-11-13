// react-bootstrap-icons types only its root module; this types the per-icon
// files graph-ui imports one by one (the Frame pin), so only those icons ship.
declare module "react-bootstrap-icons/dist/icons/*" {
  import type { Icon } from "react-bootstrap-icons";
  const icon: Icon;
  export default icon;
}
