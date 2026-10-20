fn ordinal_test_role(connection: &mut Connection, name: &str) -> String {
    let value = apply_domain_mutation(
        connection,
        StateMutation::RoleCreate(crate::model::RoleCreateInputRecord {
            game_id: "builtin-flyff-universe".to_owned(),
            name: name.to_owned(),
            launch_url: None,
            notes: None,
            cover_image_data_url: None,
            cover_image_dominant_color: None,
        }),
    )
    .unwrap();
    value["value"]["id"].as_str().unwrap().to_owned()
}

fn ordinal_test_role_names(connection: &Connection) -> Vec<String> {
    read_typed_collection::<StateRoleRecord>(connection, "roles")
        .unwrap()
        .into_iter()
        .map(|role| role.name)
        .collect()
}

#[test]
fn a_role_created_after_deletes_is_appended_and_stays_in_place_on_edits() {
    let mut connection = Connection::open_in_memory().unwrap();
    create_schema(&connection, false).unwrap();
    let a = ordinal_test_role(&mut connection, "A");
    let b = ordinal_test_role(&mut connection, "B");
    ordinal_test_role(&mut connection, "C");
    let d = ordinal_test_role(&mut connection, "D");
    for id in [a, b] {
        apply_domain_mutation(&mut connection, StateMutation::RoleDelete { id, operation_id: None })
            .unwrap();
    }
    ordinal_test_role(&mut connection, "E");
    assert_eq!(ordinal_test_role_names(&connection), ["C", "D", "E"]);

    apply_domain_mutation(
        &mut connection,
        StateMutation::RoleUpdate {
            id: d,
            input: crate::model::RoleUpdateInputRecord {
                name: Some("D renamed".to_owned()),
                ..Default::default()
            },
        },
    )
    .unwrap();
    assert_eq!(ordinal_test_role_names(&connection), ["C", "D renamed", "E"]);
}
