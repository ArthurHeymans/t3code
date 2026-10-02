/** Literal strings in jj revsets/filesets, not shell escaping. */
export function jjString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t")}"`;
}

export function jjRef(name: string): string {
  if (["@", "@-", "root()", "trunk()"].includes(name) || /^[a-f0-9]{40,64}$/.test(name))
    return name;
  const separator = name.lastIndexOf("@");
  return separator < 0
    ? jjString(name)
    : `${jjString(name.slice(0, separator))}@${name.slice(separator + 1) ? jjString(name.slice(separator + 1)) : ""}`;
}

/** Opaque object ids must not resolve as a same-named bookmark. */
export function jjCommit(id: string): string {
  return `commit_id(${jjString(id)})`;
}

export function jjFile(name: string): string {
  return `root-file:${jjString(name)}`;
}
