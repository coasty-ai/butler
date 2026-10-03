/** The capture helper's current answer wins over a historical denial. */
export function screenAccess(helper: boolean | undefined, osStatus: string) {
  const granted = osStatus === "granted";
  return {
    screen: helper === true || granted,
    screenNeedsRelaunch: helper === false && granted,
  };
}
