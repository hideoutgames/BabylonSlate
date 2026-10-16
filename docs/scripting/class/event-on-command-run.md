# Event On Command Run

Runs when the command it defines is entered in the console.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Settings

| Setting | Description |
| --- | --- |
| Command Name | The text typed in the console to run the command. An empty name uses the class name in lower case. Names used by built-in commands are reserved. |
| Description | Help text shown for the command in the console. |
| Category | Groups the command in the console's help list. Defaults to game. |
| Parameters | The arguments the command accepts. Each has a name and a type, and adds one output pin. |

## Notes

- Use it in a BDebugCommand class to create your own console command.
- Each parameter becomes an output. Integer and Boolean parameters keep their type, String and Enum parameters arrive as strings, and any other type is a Float.
