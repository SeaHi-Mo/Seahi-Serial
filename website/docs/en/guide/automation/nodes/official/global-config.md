# global-config

## Purpose

Defines a shared configuration that other nodes can reference, so common settings are maintained in one place.

## Properties

| Option | How to set it |
|---|---|
| Type | Configuration type, which decides the available fields |
| Name | The name other nodes use to reference it |

## Typical uses

| Scenario | Approach |
|---|---|
| Shared parameters | Change once and every referencing node follows |
| Separate environments | Keep one configuration node per device or site |

## Notes

Network-oriented nodes (HTTP, MQTT and similar) are removed from the bundled runtime, so their use of `global-config` does not apply in this version.
