# yaml

## Purpose

Converts between YAML text and objects, useful for reading configuration-style text or producing human-readable structures.

## Properties

| Option | How to set it |
|---|---|
| Direction | YAML to object, or object to YAML |
| Output | Overwrite the field or write to another |

## Typical uses

| Scenario | Approach |
|---|---|
| Read a configuration fragment | Convert to an object and read fields |
| Produce readable records | Convert results to YAML for logs |

## Notes

YAML expresses hierarchy through indentation, so parse failures usually mean inconsistent indentation. Make sure no tabs are mixed in.
